// Ambient types for fetch API — available in Node 18+, Bun, and browsers,
// but not included in the default ES2022 lib.
declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
