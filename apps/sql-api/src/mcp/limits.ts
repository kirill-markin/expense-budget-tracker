// The largest tool takes two scalar fields; no tool needs arrays or records.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 8;

// Fits 100,000 SQL characters even with six-byte JSON escapes, plus RPC metadata.
export const MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
