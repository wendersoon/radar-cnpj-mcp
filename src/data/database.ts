import { type DuckDBConnection, DuckDBInstance, type DuckDBValue } from '@duckdb/node-api';

export type SqlParam = DuckDBValue;

/** Thin wrapper over a DuckDB connection with parameterized queries. */
export class Database {
  private readonly instance: DuckDBInstance;
  private readonly connection: DuckDBConnection;

  private constructor(instance: DuckDBInstance, connection: DuckDBConnection) {
    this.instance = instance;
    this.connection = connection;
  }

  static async open(path: string, options: { readOnly?: boolean } = {}): Promise<Database> {
    const instance = await DuckDBInstance.create(
      path,
      options.readOnly ? { access_mode: 'READ_ONLY' } : {},
    );
    return new Database(instance, await instance.connect());
  }

  /** Runs a query and returns its rows as JSON-compatible objects. */
  async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const reader = await this.connection.runAndReadAll(sql, params);
    return reader.getRowObjectsJson() as T[];
  }

  async run(sql: string, params: SqlParam[] = []): Promise<void> {
    await this.connection.run(sql, params);
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}

/** Quotes a string as a SQL literal, for the few places parameters are not allowed. */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
