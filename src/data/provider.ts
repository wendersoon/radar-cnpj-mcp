import { stat } from 'node:fs/promises';
import { Database } from './database.ts';
import { CompanyRepository } from './repository.ts';

export class DatasetNotFoundError extends Error {
  override name = 'DatasetNotFoundError';

  constructor(path: string) {
    super(
      `Base de dados não encontrada em ${path}. Baixe os dados abertos do CNPJ antes, ` +
        'com a ferramenta baixar_dados do MCP ou no terminal: npx radar-cnpj-mcp baixar --ufs SP',
    );
  }
}

/** Supplies a repository, opening the database only when first needed. */
export interface RepositoryProvider {
  get(): Promise<CompanyRepository>;
  close(): void;
}

/** Opens the database read-only on first use, reopening it if a download replaces the file. */
export class LazyRepositoryProvider implements RepositoryProvider {
  private readonly path: string;
  private opening: Promise<{ db: Database; repository: CompanyRepository }> | undefined;
  private openedVersion: string | undefined;

  constructor(path: string) {
    this.path = path;
  }

  async get(): Promise<CompanyRepository> {
    const version = await this.fileVersion();
    if (version && version !== this.openedVersion) {
      this.close();
    }
    this.openedVersion = version ?? this.openedVersion;
    this.opening ??= this.open().catch((error: unknown) => {
      // Allow a retry after the user imports the data.
      this.opening = undefined;
      throw error;
    });
    return (await this.opening).repository;
  }

  close(): void {
    this.opening?.then(({ db }) => db.close()).catch(() => {});
    this.opening = undefined;
  }

  private async open(): Promise<{ db: Database; repository: CompanyRepository }> {
    if (!(await this.fileVersion())) {
      throw new DatasetNotFoundError(this.path);
    }
    const db = await Database.open(this.path, { readOnly: true });
    return { db, repository: new CompanyRepository(db) };
  }

  private async fileVersion(): Promise<string | undefined> {
    const file = await stat(this.path).catch(() => null);
    return file ? `${file.ino}:${file.mtimeMs}` : undefined;
  }
}
