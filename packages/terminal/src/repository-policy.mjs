// Work budgets govern each batch, not the total repository coverage.
export const INDEX_LIMITS=Object.freeze({batchFiles:32,batchBytes:1024*1024,batchMs:40,publishMs:500,fileBytes:128*1024,issues:100});
export const emptyIndexSummary=()=>({filesRead:0,filesIndexed:0,bytesRead:0,bytesIndexed:0,entriesVisited:0,filesByFormat:{},skipped:{policy:0,unsupported:0,symlink:0,oversized:0,unreadable:0},truncated:false,declarations:0,unresolved:0,issueCounts:{}});
