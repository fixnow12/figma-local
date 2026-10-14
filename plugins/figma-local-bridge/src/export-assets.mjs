import { z } from "zod";
import { fileKeyDescription } from "./file-target.mjs";

export const exportAssetsInputSchema = {
  fileKey: z.string().min(1).optional().describe(fileKeyDescription),
  nodeIds: z.array(z.string().min(1).max(160)).min(1).max(20),
  format: z.enum(["svg", "images", "png"]).default("svg"),
  pageId: z.string().min(1).max(160).optional().describe("Обязательный ID текущей PAGE для format=png."),
  scale: z.literal(1).optional().describe("Обязательный исходный масштаб 1 для format=png; без уменьшения и обрезки."),
  maxBytes: z.number().int().min(1024).max(8_000_000).default(2_000_000),
};
export const exportAssetsSchema = z.object(exportAssetsInputSchema).strict().superRefine((input, context) => {
  const issue = (path, message) => context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (input.format === "png") {
    for (const key of ["fileKey", "pageId", "scale"]) if (input[key] === undefined) issue(key, "Обязательно для format=png");
    if (new Set(input.nodeIds).size !== input.nodeIds.length) issue("nodeIds", "Повторяющиеся nodeIds недопустимы для format=png");
  } else {
    for (const key of ["pageId", "scale"]) if (input[key] !== undefined) issue(key, "Разрешено только для format=png");
  }
});

// Serialized into the existing read-only execute operation; no preview or canvas mutation.
async function exportNativePng(figma, input) {
  try {
    const page = figma.currentPage;
    const check = () => {
      if (typeof executionControl !== "undefined" && executionControl.cancelled) throw new Error("PNG export cancelled");
      if (figma.fileKey !== input.fileKey) throw new Error("PNG export fileKey mismatch");
      if (!page || page.type !== "PAGE" || page.id !== input.pageId || figma.currentPage !== page) throw new Error("PNG export pageId mismatch or page changed");
    };
    const bounds = node => ({ x: node.x, y: node.y, width: node.width, height: node.height });
    const validateNode = (node, nodeId) => {
      check();
      if (!node || node.removed || node.id !== nodeId) throw new Error("PNG export node identity mismatch: " + nodeId);
      if (["DOCUMENT", "PAGE"].includes(node.type) || typeof node.exportAsync !== "function") throw new Error("Unsupported PNG export node: " + nodeId);
      let ancestor = node;
      while (ancestor && ancestor.type !== "PAGE") ancestor = ancestor.parent;
      if (ancestor !== page) throw new Error("PNG export node is outside the requested page: " + nodeId);
      const geometry = bounds(node);
      if (!Object.values(geometry).every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0) throw new Error("Invalid native bounds: " + nodeId);
      return geometry;
    };
    const sameNode = target => {
      const geometry = validateNode(target.node, target.nodeId);
      if (target.node.type !== target.nodeType || target.node.name !== target.name || Object.keys(geometry).some(key => geometry[key] !== target.nativeBounds[key])) throw new Error("PNG export node changed: " + target.nodeId);
    };
    const pngDimensions = bytes => {
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (!(bytes instanceof Uint8Array) || bytes.length < 45 || signature.some((value, index) => bytes[index] !== value)) throw new Error("Invalid native PNG bytes");
      const uint32 = offset => bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
      let offset = 8, pixelWidth, pixelHeight, sawData = false, sawEnd = false;
      while (offset + 12 <= bytes.length) {
        const length = uint32(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) throw new Error("Truncated native PNG chunk");
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (offset === 8) {
          if (type !== "IHDR" || length !== 13) throw new Error("Invalid native PNG header");
          pixelWidth = uint32(offset + 8); pixelHeight = uint32(offset + 12);
          if (!pixelWidth || !pixelHeight || pixelWidth > 0x7fffffff || pixelHeight > 0x7fffffff) throw new Error("Invalid native PNG dimensions");
        } else if (type === "IHDR") throw new Error("Duplicate native PNG header");
        if (type === "IDAT") sawData = true;
        if (type === "IEND") {
          if (length !== 0 || !sawData || end !== bytes.length) throw new Error("Invalid native PNG end");
          sawEnd = true;
        }
        offset = end;
      }
      if (!sawEnd || offset !== bytes.length) throw new Error("Incomplete native PNG");
      return { pixelWidth, pixelHeight };
    };
    check();
    const targets = [];
    for (const nodeId of input.nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId);
      const nativeBounds = validateNode(node, nodeId);
      targets.push({ node, nodeId, nativeBounds, name: node.name, nodeType: node.type });
    }
    const assets = [];
    let used = 0;
    for (const target of targets) {
      sameNode(target);
      const bytes = await target.node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
      sameNode(target);
      const encodedLength = 4 * Math.ceil(bytes.length / 3);
      if (used + encodedLength > input.maxBytes) throw new Error("PNG export exceeds maxBytes budget");
      const dimensions = pngDimensions(bytes);
      const data = figma.base64Encode(bytes);
      if (typeof data !== "string" || data.length !== encodedLength) throw new Error("Invalid native PNG encoding");
      used += encodedLength;
      assets.push({ fileKey: input.fileKey, pageId: input.pageId, nodeId: target.nodeId, name: target.name,
        nodeType: target.nodeType, scale: 1, mimeType: "image/png", nativeBounds: target.nativeBounds, ...dimensions, data });
    }
    check();
    for (const target of targets) sameNode(target);
    return { contract: "native-png-export-v1", fileKey: input.fileKey, pageId: input.pageId,
      format: "png", scale: 1, maxBytes: input.maxBytes, nodeIds: input.nodeIds, assets, warnings: [], complete: true, encodedBytesUpperBound: used };
  } catch (error) {
    error.operationStatus = "not_applied";
    throw error;
  }
}

// Exports only explicit targets; never traverses a whole file or substitutes a bitmap for SVG.
export function buildExportAssetsCode(input) {
  if (input.format === "png") return `return await (${exportNativePng.toString()})(figma, ${JSON.stringify(input).replaceAll("</", "<\\/")});`;
  return `
const input = ${JSON.stringify(input).replaceAll("</", "<\\/")};
const assets = [], warnings = [];
const hashes = new Set();
let used = 0;
for (const nodeId of input.nodeIds) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) { warnings.push({ nodeId, reason: "missing" }); continue; }
  try {
    if (input.format === "svg") {
      const svg = await node.exportAsync({ format: "SVG_STRING", svgOutlineText: true });
      // UTF-8 upper bound prevents non-ASCII strings exceeding the transport budget.
      const bytes = svg.length * 3;
      if (used + bytes > input.maxBytes) { warnings.push({ nodeId, reason: "maxBytes" }); continue; }
      used += bytes;
      assets.push({ nodeId, name: node.name, type: "svg", svg, width: node.width, height: node.height });
    } else {
      const paints = [...(Array.isArray(node.fills) ? node.fills : []), ...(Array.isArray(node.strokes) ? node.strokes : [])];
      if (node.type === "TEXT") for (const segment of node.getStyledTextSegments(["fills"])) paints.push(...segment.fills);
      const images = paints.filter(p => p.type === "IMAGE");
      if (!images.length) warnings.push({ nodeId, reason: "no_image_paints", message: "Укажите узел с IMAGE-заливкой, а не его контейнер" });
      for (const paint of images) {
        if (hashes.has(paint.imageHash)) continue;
        const resource = figma.getImageByHash(paint.imageHash);
        if (!resource) { warnings.push({ nodeId, reason: "missing_image", imageHash: paint.imageHash }); continue; }
        const bytes = await resource.getBytesAsync();
        const encodedLength = 4 * Math.ceil(bytes.length / 3);
        if (used + encodedLength > input.maxBytes) { warnings.push({ nodeId, reason: "maxBytes", imageHash: paint.imageHash }); continue; }
        used += encodedLength;
        hashes.add(paint.imageHash);
        const mimeType = bytes[0] === 137 && bytes[1] === 80 ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : "application/octet-stream";
        assets.push({ nodeId, imageHash: paint.imageHash, mimeType, data: figma.base64Encode(bytes), paint });
      }
    }
  } catch (error) { warnings.push({ nodeId, reason: "export_failed", message: error.message }); }
}
return { assets, warnings, complete: warnings.length === 0, encodedBytesUpperBound: used };
`;
}
