import {DatabaseSync} from 'node:sqlite';
export class LocalD1 {
  constructor(){this.db=new DatabaseSync(':memory:');}
  async exec(sql){this.db.exec(sql);}
  // node:sqlite rejects D1's numbered ?N placeholders; expand them positionally.
  prepare(source){const db=this.db;let sql=source,values=[];return {bind(...v){const order=[];sql=source.replace(/\?(\d+)/g,(_,n)=>(order.push(v[Number(n)-1]??null),'?'));values=order.length?order:v;return this;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {success:true,meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};}
  async batch(statements){this.db.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
