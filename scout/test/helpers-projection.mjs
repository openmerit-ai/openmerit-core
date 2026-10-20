import {DatabaseSync} from 'node:sqlite';
export class LocalD1 {
  constructor(){this.db=new DatabaseSync(':memory:');}
  async exec(sql){this.db.exec(sql);}
  prepare(sql){const db=this.db;let values=[];return {bind(...v){values=v;return this;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){db.prepare(sql).run(...values);return {success:true};}};}
  async batch(statements){this.db.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
