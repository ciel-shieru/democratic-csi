const _ = require("lodash");

const { ControllerClientCommonDriver } = require("../controller-client-common");
const { XfsUtils } = require("../../utils/xfs");

const NODE_TOPOLOGY_KEY_NAME = "org.democratic-csi.topology/node";

/**
 * Crude local-hostpath driver which simply creates directories to be mounted
 * and uses rsync for cloning/snapshots. When xfs is enabled, layers XFS-specific
 * behaviours: filesystem verification, per-PVC project-quota enforcement via
 * xfs_quota(8), and node-side volume expansion (NodeExpandVolume).
 */
class ControllerLocalHostpathDriver extends ControllerClientCommonDriver {
  constructor(ctx, options) {
    const i_caps = _.get(
      options,
      "service.identity.capabilities.service",
      false
    );

    const c_caps = _.get(options, "service.controller.capabilities", false);
    super(...arguments);

    this._xfsEnabled = !!_.get(options, "local-hostpath.xfs.enabled", false);

    if (!i_caps) {
      this.ctx.logger.debug("setting local-hostpath identity service caps");

      options.service.identity.capabilities.service = [
        "CONTROLLER_SERVICE",
        "VOLUME_ACCESSIBILITY_CONSTRAINTS",
      ];
    }

    // When XFS is enabled, advertise ONLINE expansion so kubelet's resize
    // handler knows this driver can expand volumes while published to a node.
    if (this._xfsEnabled) {
      if (
        !options.service.identity.capabilities.volume_expansion ||
        options.service.identity.capabilities.volume_expansion.length === 0
      ) {
        this.ctx.logger.debug(
          "setting local-hostpath identity volume_expansion caps for XFS"
        );

        options.service.identity.capabilities.volume_expansion = ["ONLINE"];
      }
    }

    if (!c_caps) {
      this.ctx.logger.debug("setting local-hostpath controller service caps");

      if (
        !options.service.controller.capabilities.rpc.includes("GET_CAPACITY")
      ) {
        options.service.controller.capabilities.rpc.push("GET_CAPACITY");
      }
    }

    // When XFS is enabled, advertise EXPAND_VOLUME on the node side.
    if (this._xfsEnabled) {
      this.ctx.logger.debug(
        "setting local-hostpath node service caps for XFS"
      );

      if (
        !options.service.node.capabilities.rpc ||
        options.service.node.capabilities.rpc.length === 0
      ) {
        options.service.node.capabilities.rpc = [
          "STAGE_UNSTAGE_VOLUME",
          "GET_VOLUME_STATS",
          "EXPAND_VOLUME",
        ];
      } else if (
        !options.service.node.capabilities.rpc.includes("EXPAND_VOLUME")
      ) {
        options.service.node.capabilities.rpc.push("EXPAND_VOLUME");
      }
    }
  }

  getConfigKey() {
    return "local-hostpath";
  }

  isXfsEnabled() {
    return this._xfsEnabled;
  }

  getXfsClient() {
    if (!this.xfsClient) {
      const projectIdRange = _.get(
        this.config,
        "xfs.project_id_range",
        [1000000, 1999999]
      );
      this.xfsClient = new XfsUtils({
        executor: this.exec.bind(this),
        logger: this.ctx.logger,
        project_id_range: projectIdRange,
      });
    }
    return this.xfsClient;
  }

  async startupAssert() {
    if (!this._xfsEnabled) {
      return;
    }
    await this.getXfsClient().assertXfs(this.getControllerBasePath());
  }

  getVolumeContext(volume_id) {
    const driver = this;
    return {
      node_attach_driver: "hostpath",
      path: driver.getShareVolumePath(volume_id),
    };
  }

  getFsTypes() {
    if (this._xfsEnabled) {
      return ["xfs"];
    }
    return [];
  }

  /**
   * List of topologies associated with the *volume*
   *
   * @returns array
   */
   async getAccessibleTopology() {
    const response = await super.NodeGetInfo(...arguments);
    return [
      {
        segments: {
          [NODE_TOPOLOGY_KEY_NAME]: response.node_id,
        },
      },
    ];
  }

  /**
   * Add node topologies
   *
   * @param {*} call
   * @returns
   */
  async NodeGetInfo(call) {
    const response = await super.NodeGetInfo(...arguments);
    response.accessible_topology = {
      segments: {
        [NODE_TOPOLOGY_KEY_NAME]: response.node_id,
      },
    };
    return response;
  }

  /**
   * NodeExpandVolume: set the XFS project quota on this node's volume dir.
   *
   * This is the only expansion RPC for xfs-enabled local-hostpath. Because
   * volumes are stored locally on each node, a controller-side expand would be
   * meaningless — it could not reach the backing directory on an arbitrary
   * other node. Instead kubelet calls NodeExpandVolume after a PVC resize +
   * pod restart (or when the external-resizer triggers it).
   */
  async NodeExpandVolume(call) {
    const driver = this;

    if (!this._xfsEnabled) {
      return {};
    }

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new Error(`volume_id is required`);
    }

    const volume_path = call.request.volume_path;
    if (!volume_path) {
      throw new Error(`volume_path is required`);
    }

    const capacity_range = call.request.capacity_range || {};
    let requestedBytes =
      capacity_range.required_bytes || capacity_range.limit_bytes;
    if (!requestedBytes || requestedBytes <= 0) {
      throw new Error(
        `capacity_range.required_bytes or limit_bytes must be provided`
      );
    }

    const xfsClient = driver.getXfsClient();

    let mountpoint;
    try {
      mountpoint = await xfsClient.getMountpoint(volume_path);
    } catch (err) {
      throw new Error(
        `failed to determine XFS mountpoint for ${volume_path}: ${err.message}`
      );
    }

    if (!mountpoint) {
      throw new Error(
        `could not find mountpoint for volume_path ${volume_path}`
      );
    }

    let projId;
    try {
      const info = xfsClient.readProjectIdFile(volume_path);
      if (info.projId) {
        projId = info.projId;
      } else {
        const volId = xfsClient.extractVolumeIdFromPath(
          volume_path,
          driver.getControllerVolumeBasePath()
        );
        projId = xfsClient.deriveProjectId(volId);

        xfsClient.writeProjectIdFile(volume_path, projId, requestedBytes);
      }
    } catch (err) {
      throw new Error(
        `failed to read project ID for ${volume_path}: ${err.message}`
      );
    }

    await driver.exec("xfs_quota", [
      "-x",
      "-c",
      `limit -p bsoft=${requestedBytes} bhard=${requestedBytes} ${projId}`,
      mountpoint,
    ]);

    await driver.exec("xfs_quota", [
      "-x",
      "-c",
      `project -s -p ${volume_path} ${projId}`,
      mountpoint,
    ]);

    driver.ctx.logger.info(
      `node expanded XFS project quota projid=${projId} bytes=${requestedBytes} on path=${volume_path}`
    );

    return { capacity_bytes: requestedBytes };
  }

  async afterVolumeDirCreated(volumePath, capacityBytes) {
    if (!this._xfsEnabled) {
      return;
    }
    const xfsClient = this.getXfsClient();
    await xfsClient.assertXfs(volumePath);
    await xfsClient.setProjectQuota(volumePath, capacityBytes);
  }

  async beforeVolumeDirDeleted(volumePath) {
    if (!this._xfsEnabled) {
      return;
    }
    const xfsClient = this.getXfsClient();
    try {
      await xfsClient.clearProjectQuota(volumePath);
    } catch (err) {
      this.ctx.logger.warn(
        `failed to clear XFS quota for ${volumePath}: ${err.message}`
      );
    }
  }

  async beforeHostpathStage(volumeContext, volumeId) {
    if (!this._xfsEnabled || volumeContext.xfs !== "true") {
      return;
    }
    if (this.getNodeIsWindows()) {
      return;
    }
    const xfsClient = this.getXfsClient();
    await xfsClient.assertXfs(volumeContext.path);
    await xfsClient.reapplyProjectQuotaFromSidecar(
      volumeContext.path,
      volumeId,
      { fallbackBytes: volumeContext.xfs_quota_bytes }
    );
  }
}

module.exports.ControllerLocalHostpathDriver = ControllerLocalHostpathDriver;
