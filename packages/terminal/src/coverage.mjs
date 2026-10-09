// Report bounded inventory reads without exposing unprojected source values.
export function collectionLimits(value, fields) {
  return Object.entries(fields).flatMap(([collection, limit]) => Array.isArray(value?.[collection]) && value[collection].length > limit
    ? [{ collection, limit, omitted: value[collection].length - limit }] : []);
}
export function hardwareLimits(value) {
  const limits = collectionLimits(value, { hosts: 64 });
  for (const host of (value?.hosts ?? []).slice(0, 64)) {
    for (const entry of collectionLimits(host, { accelerators: 16, loadedModels: 100 })) {
      const collection = `hosts[].${entry.collection}`, existing = limits.find(item => item.collection === collection);
      if (existing) existing.omitted += entry.omitted;
      else limits.push({ ...entry, collection });
    }
  }
  return limits;
}
export function limitNote(limits = []) {
  return limits.length ? ' Collection limits omitted ' + limits.map(item => `${item.omitted} ${item.collection} (limit ${item.limit})`).join('; ') + '. Inventory is incomplete.' : '';
}

export function configurationLimits(value) {
  const limits = collectionLimits(value, { runtimes: 8, inventory: 100, deployments: 200, capacityPools: 100 });
  for (const [field, bound] of [['inventory', 100], ['deployments', 200]]) {
    for (const item of (Array.isArray(value?.[field]) ? value[field] : []).slice(0, bound)) {
      for (const entry of collectionLimits(item, { poolIds: 16 })) {
        const collection = `${field}[].poolIds`, existing = limits.find(limit => limit.collection === collection);
        if (existing) existing.omitted += entry.omitted;
        else limits.push({ ...entry, collection });
      }
    }
  }
  return limits;
}
