// Every record means one request.
export function requestWeight() {
  return 1;
}
export function requestCount(records) {
  return records.length;
}
