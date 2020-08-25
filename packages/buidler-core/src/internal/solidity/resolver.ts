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

const NODE_MODULES = "node_modules";

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
    // Invalid source name:
    //  * Absolute
    //  * start with .
    //  * backslash
    //  * normalized -- i.e. no a/../
    if (path.isAbsolute(sourceName)) {
      throw new BuidlerError(
        ERRORS.RESOLVER.INVALID_SOURCE_NAME_ABSOLUTE_PATH,
        { name: sourceName }
      );
    }

    if (sourceName.startsWith(".")) {
      throw new BuidlerError(
        ERRORS.RESOLVER.INVALID_SOURCE_NAME_RELATIVE_PATH,
        { name: sourceName }
      );
    }

    // We check this before normalizing so we are sure that the difference
    // comes from slash vs backslash
    if (slash(sourceName) !== sourceName) {
      throw new BuidlerError(ERRORS.RESOLVER.INVALID_SOURCE_NAME_BACKSLASHES, {
        name: sourceName,
      });
    }

    if (this._normalizePath(sourceName) !== sourceName) {
      throw new BuidlerError(ERRORS.RESOLVER.INVALID_SOURCE_NOT_NORMALIZED, {
        name: sourceName,
      });
    }

    if (await this._isSourceNameFromLocalSourceFile(sourceName)) {
      return this._resolveLocalSourceName(sourceName);
    }

    return this._resolveLibrarySourceName(sourceName);
  }

  /**
   * Resolves an import from an already resolved file.
   * @param from The file were the import statement is present.
   * @param imported The path in the import statement.
   */
  public async resolveImport(
    from: ResolvedFile,
    imported: string
  ): Promise<ResolvedFile> {
    const scheme = this._getUriScheme(imported);
    if (scheme !== undefined) {
      throw new BuidlerError(ERRORS.RESOLVER.INVALID_IMPORT_PROTOCOL, {
        from: from.globalName,
        imported,
        protocol: scheme,
      });
    }

    if (slash(imported) !== imported) {
      throw new BuidlerError(ERRORS.RESOLVER.INVALID_IMPORT_BACKSLASH, {
        from: from.globalName,
        imported,
      });
    }

    if (path.isAbsolute(imported)) {
      throw new BuidlerError(ERRORS.RESOLVER.INVALID_IMPORT_ABSOLUTE_PATH, {
        from: from.globalName,
        imported,
      });
    }

    try {
      if (!this._isRelativeImport(imported)) {
        return this.resolveSourceName(this._normalizePath(imported));
      }

      const sourceName = await this._relativeImportToSourceName(from, imported);
      return this.resolveSourceName(sourceName);
    } catch (error) {
      if (BuidlerError.isBuidlerError(error)) {
        if (
          error.number === ERRORS.RESOLVER.FILE_NOT_FOUND.number ||
          error.number === ERRORS.RESOLVER.LIBRARY_FILE_NOT_FOUND.number
        ) {
          throw new BuidlerError(
            ERRORS.RESOLVER.IMPORTED_FILE_NOT_FOUND,
            {
              imported,
              from: from.globalName,
            },
            error
          );
        }

        if (error.number === ERRORS.RESOLVER.WRONG_CASING.number) {
          throw new BuidlerError(
            ERRORS.RESOLVER.INVALID_IMPORT_WRONG_CASING,
            {
              imported,
              from: from.globalName,
            },
            error
          );
        }
      }

      // tslint:disable-next-line only-buidler-error
      throw error;
    }
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
      packagePath = this._resolveNodeModulesFileFromProjectRoot(
        path.join(libraryName, "package.json")
      );
    } catch (error) {
      // if the project is using a dependency from buidler itself but it can't
      // be found, this means that a global installation is being used, so we
      // resolve the dependency relative to this file
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

    const nodeModulesPath = path.dirname(path.dirname(packagePath));

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
    const sourceName = this._normalizePath(
      path.join(path.dirname(from.globalName), imported)
    );

    if (from.library === undefined) {
      const nmIndex = sourceName.indexOf(`${NODE_MODULES}/`);
      if (nmIndex !== -1) {
        return sourceName.substr(nmIndex + NODE_MODULES.length + 1);
      }
    }

    if (sourceName.startsWith("../")) {
      // If the file with the import is local, and the normalized version
      // starts with ../ means that it's trying to get outside of the project.
      if (from.library === undefined) {
        throw new BuidlerError(
          ERRORS.RESOLVER.INVALID_IMPORT_OUTSIDE_OF_PROJECT,
          { from: from.globalName, imported }
        );
      }

      // If the file is being imported from a library, this means that it's
      // trying to reach another one.
      throw new BuidlerError(ERRORS.RESOLVER.ILLEGAL_IMPORT, {
        from: from.globalName,
        imported,
      });
    }

    return sourceName;
  }

  private async _isSourceNameFromLocalSourceFile(
    sourceName: string
  ): Promise<boolean> {
    if (sourceName.includes(NODE_MODULES)) {
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

  private _resolveNodeModulesFileFromProjectRoot(fileName: string) {
    return require.resolve(fileName, {
      paths: [this._projectRoot],
    });
  }

  private _getLibraryName(sourceName: string): string {
    if (sourceName.startsWith("@")) {
      return sourceName.slice(
        0,
        sourceName.indexOf("/", sourceName.indexOf("/") + 1)
      );
    }

    return sourceName.slice(0, sourceName.indexOf("/"));
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
      // We only want to make sure that we are using / here
      trueCaseSourceName = slash(path.relative(fromDir, tcp));
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
      throw new BuidlerError(ERRORS.RESOLVER.WRONG_SOURCE_NAME_CASING, {
        incorrect: sourceName,
        correct: trueCaseSourceName,
      });
    }
  }

  private _normalizePath(p: string): string {
    return slash(path.normalize(p));
  }

  private _getUriScheme(s: string): string | undefined {
    const re = /([a-zA-Z]+):\/\//;
    const match = re.exec(s);
    if (match === null) {
      return undefined;
    }

    return match[1];
  }
}
