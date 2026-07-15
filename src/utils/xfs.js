const fs = require("fs");

const XFS_PROJECT_ID_FILE = ".csi-xfs-project-id";

class XfsUtils {
  constructor(options = {}) {
    const xfs = this;
    xfs.options = options || {};

    if (!options.executor) {
      throw new Error("executor is required for XfsUtils");
    }

    if (!options.logger) {
      options.logger = console;
    }

    if (
      !Array.isArray(options.project_id_range) ||
      options.project_id_range.length !== 2
    ) {
      options.project_id_range = [1000000, 1999999];
    }
  }

  /**
   * Verify that `path` is on an XFS filesystem.
   * Uses `findmnt -n -o FSTYPE --target <path>` and asserts output is `xfs`.
   */
  async assertXfs(path) {
    const xfs = this;
    try {
      const result = await xfs.exec("findmnt", [
        "-n",
        "-o",
        "FSTYPE",
        "--target",
        path,
      ]);
      const fstype = result.stdout.trim();
      if (fstype !== "xfs") {
        throw new Error(
          `path ${path} is on filesystem type '${fstype}', expected 'xfs'`
        );
      }
      xfs.logger.debug(`verified path ${path} is on XFS`);
      return true;
    } catch (err) {
      if (err.code && err.code !== 0) {
        throw new Error(
          `failed to verify XFS for path ${path}: ${err.stderr || err.message}`
        );
      }
      throw err;
    }
  }

  /**
   * Get the mountpoint containing a given path.
   * Uses `findmnt -n -o TARGET --target <path>`.
   */
  async getMountpoint(path) {
    const xfs = this;
    try {
      const result = await xfs.exec("findmnt", [
        "-n",
        "-o",
        "TARGET",
        "--target",
        path,
      ]);
      return result.stdout.trim();
    } catch (err) {
      throw new Error(
        `failed to determine mountpoint for ${path}: ${err.message}`
      );
    }
  }

  /**
   * Get the filesystem source device/path backing a given path.
   * Uses `findmnt -n -o SOURCE --target <path>`.
   */
  async getFilesystemSource(path) {
    const xfs = this;
    try {
      const result = await xfs.exec("findmnt", [
        "-n",
        "-o",
        "SOURCE",
        "--target",
        path,
      ]);
      return result.stdout.trim();
    } catch (err) {
      throw new Error(
        `failed to determine source for ${path}: ${err.message}`
      );
    }
  }

  /**
   * Check that `srcPath` and `dstPath` resolve to the same XFS filesystem.
   * Reflinks cannot cross filesystems.
   */
  async assertSameFilesystem(srcPath, dstPath) {
    const xfs = this;
    const srcSource = await xfs.getFilesystemSource(srcPath);
    const dstSource = await xfs.getFilesystemSource(dstPath);

    if (srcSource !== dstSource) {
      throw new Error(
        `source ${srcPath} (${srcSource}) and destination ${dstPath} (${dstSource}) are on different filesystems; reflinks cannot cross filesystem boundaries`
      );
    }
  }

  /**
   * Set XFS project quota for a volume directory.
   * Derives projId from volume_id hash if not provided, then runs xfs_quota commands
   * and persists the sidecar file.
   */
  async setProjectQuota(volumePath, bytes, { projId } = {}) {
    const xfs = this;

    let mountpoint;
    try {
      mountpoint = await xfs.getMountpoint(volumePath);
    } catch (err) {
      throw new Error(
        `setProjectQuota failed to get mountpoint for ${volumePath}: ${err.message}`
      );
    }

    if (!projId) {
      const volumeId = xfs.extractVolumeIdFromPath(volumePath);
      projId = xfs.deriveProjectId(volumeId);
      xfs.writeProjectIdFile(volumePath, projId, bytes);
    }

    await xfs.exec("xfs_quota", [
      "-x",
      "-c",
      `project -s -p ${volumePath} ${projId}`,
      mountpoint,
    ]);

    const bsoft = bytes;
    const bhard = bytes;
    await xfs.exec("xfs_quota", [
      "-x",
      "-c",
      `limit -p bsoft=${bsoft} bhard=${bhard} ${projId}`,
      mountpoint,
    ]);

    xfs.writeProjectIdFile(volumePath, projId, bytes);

    xfs.logger.info(
      `set XFS project quota projid=${projId} bytes=${bytes} on path=${volumePath}`
    );
  }

  /**
   * Clear the XFS project quota for a volume so project IDs are not leaked.
   */
  async clearProjectQuota(volumePath) {
    const xfs = this;
    let mountpoint;
    try {
      mountpoint = await xfs.getMountpoint(volumePath);
    } catch (err) {
      xfs.logger.warn(
        `clearProjectQuota failed to get mountpoint for ${volumePath}: ${err.message}`
      );
      // best-effort: still remove sidecar
      try {
        const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
        fs.unlinkSync(idFilePath);
      } catch (e) {
        // ignore
      }
      return;
    }

    const xfsProjInfo = xfs.readProjectIdFile(volumePath);
    let projId = xfsProjInfo.projId;
    if (projId) {
      try {
        await xfs.exec("xfs_quota", [
          "-x",
          "-c",
          `limit -p -d ${projId}`,
          mountpoint,
        ]);
        xfs.logger.info(
          `cleared XFS project quota projid=${projId} on path=${volumePath}`
        );
      } catch (err) {
        xfs.logger.warn(
          `failed to clear XFS project quota projid=${projId}: ${err.message}`
        );
      }
    }

    const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
    try {
      fs.unlinkSync(idFilePath);
    } catch (e) {
      // ignore
    }
  }

  /**
   * Clear all inherited XFS project quota mappings and the inode's projid for a directory.
   */
  async clearInheritedProjectQuota(volumePath) {
    const xfs = this;
    let mountpoint;
    try {
      mountpoint = await xfs.getMountpoint(volumePath);
    } catch (err) {
      xfs.logger.debug(
        `clearInheritedProjectQuota failed to get mountpoint for ${volumePath}: ${err.message}`
      );
      return;
    }

    try {
      await xfs.exec("xfs_quota", [
        "-x",
        "-c",
        `project -d -p ${volumePath}`,
        mountpoint,
      ]);
    } catch (err) {
      xfs.logger.debug(
        `no project mapping to remove for ${volumePath}: ${err.message}`
      );
    }

    try {
      await xfs.exec("xfs_quota", [
        "-x",
        "-c",
        `chprojid ${volumePath} 0`,
        mountpoint,
      ]);
    } catch (err) {
      xfs.logger.debug(
        `could not reset projid to 0 for ${volumePath}: ${err.message}`
      );
    }

    xfs.logger.info(
      `cleared inherited XFS quotas for path=${volumePath}`
    );
  }

  /**
   * Reflink-copy a directory tree. Atomic per-file, CoW across the whole tree.
   */
  async reflinkCopy(src, dst) {
    const xfs = this;
    fs.mkdirSync(dst, { recursive: true });

    await xfs.exec("cp", [
      "--archive",
      "--reflink=always",
      xfs.stripTrailingSlash(src) + "/.",
      xfs.stripTrailingSlash(dst) + "/",
    ]);

    try {
      const sidecarPath = dst + "/" + XFS_PROJECT_ID_FILE;
      fs.unlinkSync(sidecarPath);
    } catch (e) {
      // ignore — source may not have a sidecar file
    }

    try {
      await xfs.clearInheritedProjectQuota(dst);
    } catch (err) {
      xfs.logger.warn(
        `failed to clear inherited XFS quotas for ${dst}: ${err.message}`
      );
    }
  }

  /**
   * Re-apply the XFS project quota from the sidecar file.
   * Reads projId and quotaBytes from sidecar; derives projId if absent (writes it back).
   * Uses fallbackBytes or sidecar bytes as final amount. Best-effort with warn on failure,
   * soft-skip if no quota bytes available.
   */
  async reapplyProjectQuotaFromSidecar(volumePath, volumeId, { fallbackBytes } = {}) {
    const xfs = this;

    let projId;
    try {
      const info = xfs.readProjectIdFile(volumePath);
      if (info.projId) {
        projId = info.projId;
      } else {
        projId = xfs.deriveProjectId(volumeId);
        // preserve any quota bytes we may have read from the sidecar
        const quotaBytes = info.quotaBytes !== null ? String(info.quotaBytes) : "";
        xfs.writeProjectIdFile(volumePath, projId, quotaBytes);
      }
    } catch (err) {
      xfs.logger.warn(
        `failed to read project ID for ${volumePath}: ${err.message}`
      );
      return;
    }

    const sidecarInfo = xfs.readProjectIdFile(volumePath);
    let quotaBytes = sidecarInfo.quotaBytes;
    if (!quotaBytes || quotaBytes <= 0) {
      quotaBytes = fallbackBytes !== null && fallbackBytes !== undefined ? fallbackBytes : null;
    }

    if (!quotaBytes || quotaBytes <= 0) {
      xfs.logger.debug(
        `no XFS quota bytes available for ${volumePath}, skipping quota re-apply`
      );
      return;
    }

    let mountpoint;
    try {
      mountpoint = await xfs.getMountpoint(volumePath);
    } catch (err) {
      xfs.logger.warn(
        `failed to get mountpoint for ${volumePath}: ${err.message}`
      );
      return;
    }

    try {
      await xfs.exec("xfs_quota", [
        "-x",
        "-c",
        `project -s -p ${volumePath} ${projId}`,
        mountpoint,
      ]);
    } catch (err) {
      xfs.logger.warn(
        `failed to re-apply XFS project quota binding for ${volumePath}: ${err.message}`
      );
    }

    try {
      const bsoft = quotaBytes;
      const bhard = quotaBytes;
      await xfs.exec("xfs_quota", [
        "-x",
        "-c",
        `limit -p bsoft=${bsoft} bhard=${bhard} ${projId}`,
        mountpoint,
      ]);

      xfs.logger.info(
        `re-applied XFS project quota projid=${projId} bytes=${quotaBytes} on path=${volumePath}`
      );
    } catch (err) {
      xfs.logger.warn(
        `failed to re-apply XFS project quota for ${volumePath}: ${err.message}`
      );
    }
  }

  /**
   * Derive a deterministic project ID from a volume_id via djb2-style hash.
   */
  deriveProjectId(volumeId) {
    const xfs = this;
    const range = xfs.options.project_id_range;

    let hash = 0;
    for (let i = 0; i < volumeId.length; i++) {
      hash = (hash * 31 + volumeId.charCodeAt(i)) >>> 0;
    }

    const rangeSize = range[1] - range[0] + 1;
    return range[0] + (hash % rangeSize);
  }

  /**
   * Read the persisted sidecar file. Returns { projId, quotaBytes }.
   */
  readProjectIdFile(volumePath) {
    const xfs = this;
    try {
      const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
      if (fs.existsSync(idFilePath)) {
        const content = fs.readFileSync(idFilePath, "utf8").trim();
        const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
        const projId = lines[0] ? parseInt(lines[0], 10) : null;
        const quotaBytes =
          lines.length > 1 && lines[1]
            ? parseInt(lines[1], 10)
            : null;
        return { projId: isNaN(projId) ? null : projId, quotaBytes };
      }
    } catch (e) {
      // ignore
    }
    return { projId: null, quotaBytes: null };
  }

  /**
   * Write the project ID and quota bytes to the sidecar file.
   */
  writeProjectIdFile(volumePath, projId, quotaBytes) {
    const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
    const lines = [String(projId)];
    if (quotaBytes !== undefined && quotaBytes !== null) {
      lines.push(String(quotaBytes));
    }
    fs.writeFileSync(idFilePath, lines.join("\n") + "\n", { mode: "0644" });
  }

  /**
   * Extract the volume_id from a path. Strips basePath prefix or falls back to basename.
   */
  extractVolumeIdFromPath(volumePath, basePath) {
    const xfs = this;
    if (basePath && volumePath.startsWith(basePath + "/")) {
      return volumePath.slice(basePath.length + 1);
    }
    return volumePath.split("/").filter(Boolean).pop();
  }

  /**
   * Strip trailing slash from a string.
   */
  stripTrailingSlash(s) {
    if (s.length > 1) {
      return s.replace(/\/$/, "");
    }
    return s;
  }

  /**
   * Internal exec wrapper around the provided executor function.
   */
  async exec(command, args) {
    const xfs = this;
    return new Promise((resolve, reject) => {
      try {
        const result = xfs.options.executor(command, args);
        if (result && typeof result.then === "function") {
          resolve(result);
        } else {
          // executor returned a non-Promise object directly
          resolve(result);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  get logger() {
    return this.options.logger;
  }
}

module.exports.XfsUtils = XfsUtils;
module.exports.XFS_PROJECT_ID_FILE = XFS_PROJECT_ID_FILE;
