// hana-dsh-adapter: canonical Windows path containment checks.
// Blocks sibling-prefix bypasses (<root>2), '..' traversal and
// file paths by requiring an existing directory under an allowed root.
import path from "node:path";

export class WorkspacePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspacePolicyError";
    this.code = code;
  }
}

function fold(p) {
  // Windows paths are case-insensitive; canonicalize comparison accordingly.
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export class WorkspacePolicy {
  constructor({ roots }) {
    if (!Array.isArray(roots) || roots.length === 0) {
      throw new WorkspacePolicyError("invalid-root", "at least one workspace root is required");
    }
    const seen = new Set();
    this.roots = [];
    for (const root of roots) {
      if (typeof root !== "string" || !root.trim()) {
        throw new WorkspacePolicyError("invalid-root", "workspace root must be a non-empty string");
      }
      if (!path.isAbsolute(root)) {
        throw new WorkspacePolicyError("invalid-root", `workspace root must be absolute: ${root}`);
      }
      const canonical = path.normalize(path.resolve(root));
      const key = fold(canonical);
      if (!seen.has(key)) {
        seen.add(key);
        this.roots.push(canonical);
      }
    }
    if (this.roots.length === 0) {
      throw new WorkspacePolicyError("invalid-root", "at least one workspace root is required");
    }
  }

  /** Resolve + normalize an input path; returns the canonical absolute form. */
  canonicalize(cwd) {
    if (typeof cwd !== "string" || !cwd.trim()) {
      throw new WorkspacePolicyError("invalid-path", "cwd must be a non-empty string");
    }
    try {
      return path.normalize(path.resolve(cwd));
    } catch {
      throw new WorkspacePolicyError("invalid-path", `cwd is not a valid path: ${cwd}`);
    }
  }

  /**
   * Check that `cwd` is inside one of the allowed roots.
   * Returns the canonical (resolved) cwd path — never the root itself.
   * Throws WorkspacePolicyError with code `outside-root` otherwise.
   */
  checkAllowed(cwd) {
    const resolved = this.canonicalize(cwd);
    const folded = fold(resolved);
    for (const root of this.roots) {
      const foldedRoot = fold(root);
      if (folded === foldedRoot) {
        return resolved;
      }
      if (foldedRoot.endsWith(path.sep)) {
        // Drive root like C:\ — everything below is contained.
        if (folded.startsWith(foldedRoot)) {
          return resolved;
        }
      } else if (folded.startsWith(foldedRoot + path.sep)) {
        return resolved;
      }
    }
    throw new WorkspacePolicyError(
      "outside-root",
      `cwd "${cwd}" is outside all allowed workspace roots: ${this.roots.join(", ")}`,
    );
  }

  listRoots() {
    return [...this.roots];
  }
}
