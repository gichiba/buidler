import fsExtra from "fs-extra";
import path from "path";
import slash from "slash";

import { BuidlerError } from "../core/errors";
import { ERRORS } from "../core/errors-list";

import { Parser } from "./parse";

export interface ResolvedFilesMap {
  [globalName: string]: ResolvedFile;
}

export interface LibraryInfo {
  name: string;
  version: string;
}

interface FileContent {
  rawContent: string;
  imports: string[];
  versionPragmas: string[];
}

export class ResolvedFile {
  public readonly library?: LibraryInfo;

  constructor(
    // TODO-HH: Rename this to sourceName. This is what the solidity team uses.
    public readonly globalName: string,
    public readonly absolutePath: string,
    public readonly content: FileContent,
    // IMPORTANT: Mapped to ctime, NOT mtime. mtime isn't updated when the file
    // properties (e.g. its name) are changed, only when it's content changes.
    public readonly lastModificationDate: Date,
    libraryName?: string,
    libraryVersion?: string
  ) {
    this.globalName = globalName;
    this.absolutePath = absolutePath;
    this.content = content;
    this.lastModificationDate = lastModificationDate;

    if (libraryName !== undefined && libraryVersion !== undefined) {
      this.library = {
        name: libraryName,
        version: libraryVersion,
      };
    }
  }

  public getVersionedName() {
    return (
      this.globalName +
      (this.library !== undefined ? `@v${this.library.version}` : "")
    );
  }
}

export class Resolver {
  constructor(
    private readonly _projectRoot: string,
    private readonly _parser: Parser
  ) {}

  /**
   * Resolves a source name into a ResolvedFile.
   *
   * @param sourceName The source name as it would be provided to solc.
   */
  public async resolveSourceName(sourceName: string): Promise<ResolvedFile> {
    if (path.isAbsolute(sourceName)) {
      throw new Error("Source names shouldn't be absolute");
    }

    if (sourceName.startsWith(".")) {
      throw new Error("Source names can't start with .");
    }

    if (slash(sourceName) !== sourceName) {
      throw new Error("Source names should use / and not \\");
    }

    if (slash(path.normalize(sourceName)) !== sourceName) {
      throw new Error("Source names should not include ../ or ./ ");
    }

    if (await this._isSourceNameFromLocalSourceFile(sourceName)) {
      return this._resolveLocalSourceName(sourceName);
    }

    return this._resolveLibrarySourceName(sourceName);
  }

  public async resolveImport(
    from: ResolvedFile,
    imported: string
  ): Promise<ResolvedFile> {
    if (!this._isRelativeImport(imported)) {
      // TODO: What if it's not relative but more like: asd/../.../asd.
      //  Should it fail? How?
      return this.resolveSourceName(imported);
    }

    const sourceName = await this._relativeImportToSourceName(from, imported);
    return this.resolveSourceName(sourceName);
  }

  private async _resolveLocalSourceName(
    sourceName: string
  ): Promise<ResolvedFile> {
    await this._validateSourceNameExistenceAndCasing(
      sourceName,
      this._projectRoot,
      false
    );

    const absolutePath = path.join(this._projectRoot, sourceName);
    return this._resolveFile(sourceName, absolutePath);
  }

  private async _resolveLibrarySourceName(
    sourceName: string
  ): Promise<ResolvedFile> {
    const libraryName = this._getLibraryName(sourceName);

    let packagePath;
    try {
      packagePath = this._resolveFromProjectRoot(
        path.join(libraryName, "package.json")
      );
    } catch (error) {
      // if the project is using a dependency from buidler itself but it can't be found, this means that a global
      // installation is being used, so we resolve the dependency relative to this file
      if (libraryName === "@nomiclabs/buidler") {
        const buidlerCoreDir = path.join(__dirname, "..", "..");
        packagePath = path.join(buidlerCoreDir, "package.json");
      } else {
        throw new BuidlerError(
          ERRORS.RESOLVER.LIBRARY_NOT_INSTALLED,
          {
            library: libraryName,
          },
          error
        );
      }
    }

    const nodeModulesPath = path.dirname(packagePath);

    await this._validateSourceNameExistenceAndCasing(
      sourceName,
      nodeModulesPath,
      true
    );

    const packageInfo = await fsExtra.readJson(packagePath);
    const libraryVersion = packageInfo.version;

    return this._resolveFile(
      sourceName,
      path.join(nodeModulesPath, sourceName),
      libraryName,
      libraryVersion
    );
  }

  private async _relativeImportToSourceName(
    from: ResolvedFile,
    imported: string
  ): Promise<string> {
    if (from.library === undefined) {
      const NM = "node_modules";
      const nmIndex = imported.indexOf(NM);
      if (nmIndex !== -1) {
        return imported.substr(nmIndex + NM.length + 1);
      }
    }

    if (slash(imported) !== imported) {
      throw new Error("Imports should use / and not \\");
    }

    const sourceName = slash(
      path.normalize(path.join(from.globalName, imported))
    );

    if (sourceName.startsWith("../")) {
      throw new Error("Invalid relative import. Too many ../'s");
    }

    return sourceName;
  }

  private async _isSourceNameFromLocalSourceFile(
    sourceName: string
  ): Promise<boolean> {
    if (sourceName.includes("node_modules")) {
      return false;
    }

    // The file path's casing doesn't matter here.
    const localPath = path.join(this._projectRoot, sourceName);
    return fsExtra.pathExists(localPath);
  }

  private async _resolveFile(
    sourceName: string,
    absolutePath: string,
    libraryName?: string,
    libraryVersion?: string
  ): Promise<ResolvedFile> {
    const rawContent = await fsExtra.readFile(absolutePath, {
      encoding: "utf8",
    });
    const stats = await fsExtra.stat(absolutePath);
    const lastModificationDate = new Date(stats.ctime);

    const parsedContent = this._parser.parse(rawContent, absolutePath);

    const content = {
      rawContent,
      ...parsedContent,
    };

    return new ResolvedFile(
      sourceName,
      absolutePath,
      content,
      lastModificationDate,
      libraryName,
      libraryVersion
    );
  }

  private _isRelativeImport(imported: string): boolean {
    return imported.startsWith("./") || imported.startsWith("../");
  }

  private _resolveFromProjectRoot(fileName: string) {
    return require.resolve(fileName, {
      paths: [this._projectRoot],
    });
  }

  private _getLibraryName(globalName: string): string {
    if (globalName.startsWith("@")) {
      return globalName.slice(
        0,
        globalName.indexOf("/", globalName.indexOf("/") + 1)
      );
    }

    return globalName.slice(0, globalName.indexOf("/"));
  }

  private async _validateSourceNameExistenceAndCasing(
    sourceName: string,
    fromDir: string,
    isLibrary: boolean
  ) {
    const { trueCasePath } = await import("true-case-path");

    let trueCaseSourceName: string;
    try {
      const tcp = await trueCasePath(sourceName, fromDir);
      trueCaseSourceName = slash(path.relative(this._projectRoot, tcp));
    } catch (error) {
      if (
        typeof error.message === "string" &&
        error.message.includes("no matching file exists")
      ) {
        const errorDescriptor = isLibrary
          ? ERRORS.RESOLVER.LIBRARY_FILE_NOT_FOUND
          : ERRORS.RESOLVER.FILE_NOT_FOUND;

        throw new BuidlerError(errorDescriptor, {
          file: sourceName,
        });
      }

      // tslint:disable-next-line only-buidler-error
      throw error;
    }

    if (trueCaseSourceName !== sourceName) {
      throw new Error(
        `Invalid casing. Trying to import ${sourceName} but probably meant ${trueCaseSourceName}`
      );
    }
  }
}
