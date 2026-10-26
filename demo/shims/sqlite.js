// node:sqlite's DatabaseSync, on top of sql.js (SQLite compiled to WebAssembly), so the server's
// data layer runs unchanged in the browser. Only the parts Hisaab uses: exec, prepare().get/all/run.
export class DatabaseSync {
  constructor() {
    const { SQL, bytes } = globalThis.__hisaabSql;
    this.raw = new SQL.Database(bytes ?? undefined);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  prepare(sql) {
    return new Statement(this.raw, sql);
  }

  close() {
    this.raw.close();
  }
}

class Statement {
  constructor(raw, sql) {
    this.raw = raw;
    this.sql = sql;
  }

  #run(params, mode) {
    const st = this.raw.prepare(this.sql);
    try {
      if (params.length) st.bind(params.map((p) => (p === undefined ? null : p)));
      if (mode === 'get') return st.step() ? st.getAsObject() : undefined;
      if (mode === 'all') {
        const rows = [];
        while (st.step()) rows.push(st.getAsObject());
        return rows;
      }
      st.step();
      return { changes: this.raw.getRowsModified(), lastInsertRowid: this.raw.exec('SELECT last_insert_rowid()')[0].values[0][0] };
    } finally {
      st.free();
    }
  }

  get(...params) { return this.#run(params, 'get'); }
  all(...params) { return this.#run(params, 'all'); }
  run(...params) { return this.#run(params, 'run'); }
}
