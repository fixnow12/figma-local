import { z } from "zod";
import { fileKeyDescription } from "./file-target.mjs";
import { fidelityFields, paintsSchema, textFidelityFields } from "./fidelity.mjs";

const keySchema = z.string().min(1).max(160);
const nameSchema = z.string().min(1).max(240);
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "Ожидается цвет #RRGGBB или #RRGGBBAA");

const tokenRef = z.object({ token: z.string().min(1).max(160) }).strict();
const colorValue = z.union([hexColor, tokenRef]);
const numberValue = z.union([z.number(), tokenRef]);
const nonnegativeValue = z.union([z.number().nonnegative(), tokenRef]);
const positiveValue = z.union([z.number().positive(), tokenRef]);
const unitValue = z.union([z.number().min(0).max(1), tokenRef]);
const dimension = z.union([positiveValue, z.enum(["fill", "hug"])]);
const paddingObject = z
  .object({
    top: nonnegativeValue.optional(),
    right: nonnegativeValue.optional(),
    bottom: nonnegativeValue.optional(),
    left: nonnegativeValue.optional(),
  })
  .strict();
const padding = z.union([nonnegativeValue, paddingObject]);
const concreteDimension = z.union([z.number().positive(), z.enum(["fill", "hug"])]);
const concretePaddingObject = z.object({
  top: z.number().nonnegative().optional(),
  right: z.number().nonnegative().optional(),
  bottom: z.number().nonnegative().optional(),
  left: z.number().nonnegative().optional(),
}).strict();
const concretePadding = z.union([z.number().nonnegative(), concretePaddingObject]);

// Fresh schemas keep the MCP public description free of shared $ref objects.
const effectSchema = () => z.object({
  type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR", "GLASS"]),
  radius: z.number().nonnegative(),
  refraction: z.number().min(0).max(1).optional(), depth: z.number().min(1).optional(),
  lightAngle: z.number().finite().optional(), lightIntensity: z.number().min(0).max(1).optional(),
  dispersion: z.number().min(0).max(1).optional(), splay: z.number().finite().optional(),
  color: z.union([
    z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
    z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1) }).strict(),
  ]).optional(),
  offset: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  spread: z.number().optional(),
  visible: z.boolean().optional(),
  blendMode: z.enum(["NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LIGHTEN", "SCREEN", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"]).optional(),
  showShadowBehindNode: z.boolean().optional(),
  boundVariables: z.record(z.object({ type: z.literal("VARIABLE_ALIAS"), id: z.string().min(1) }).strict()).optional(),
}).strict().superRefine((value, ctx) => {
  const glassFields = ["refraction", "depth", "lightAngle", "lightIntensity", "dispersion", "splay"];
  if (value.type === "GLASS") {
    for (const field of glassFields.filter(f => f !== "splay")) if (value[field] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "GLASS требует " + field });
    if (value.boundVariables && Object.keys(value.boundVariables).length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "GLASS не поддерживает boundVariables" });
  } else if (glassFields.some(f => value[f] !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Параметры стекла допустимы только для GLASS" });
  if (value.type.endsWith("SHADOW")) {
    if (!value.color) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["color"], message: "Для тени нужен color" });
    if (!value.offset) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offset"], message: "Для тени нужен offset" });
  } else if (["color", "offset", "spread", "blendMode", "showShadowBehindNode"].some(key => value[key] !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Параметры тени недопустимы для размытия" });
  }
  if (value.type === "INNER_SHADOW" && value.showShadowBehindNode !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "showShadowBehindNode поддерживается только DROP_SHADOW" });
  }
});

const textUnit = (positive = false) => z.object({
  unit: z.enum(["PIXELS", "PERCENT"]),
  value: positive ? z.number().positive() : z.number(),
}).strict();

function typographyFields(mode = "internal") {
  const numeric = positive => mode === "public"
    ? publicNumber(positive ? { exclusiveMinimum: 0 } : {})
    : mode === "concrete" ? (positive ? z.number().positive() : z.number())
      : positive ? positiveValue : numberValue;
  return {
    ...textFidelityFields(),
    fontFamily: z.string().min(1).optional(),
    fontStyle: z.string().min(1).optional(),
    // Backward-compatible name for the actual Figma font style, not a CSS weight.
    fontWeight: z.string().min(1).optional(),
    fontSize: numeric(true).optional(),
    lineHeight: z.union([numeric(true), z.literal("AUTO"), textUnit(true), z.object({ unit: z.literal("AUTO") }).strict()]).optional(),
    letterSpacing: z.union([numeric(false), textUnit()]).optional(),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    textStyleId: z.string().optional(),
  };
}

function rangeTypographyFields(mode) {
  const { textAutoResize: _resize, textAlignVertical: _align, ...fields } = typographyFields(mode);
  return fields;
}
const textRunsSchema = (mode = "internal") => z.array(z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  ...rangeTypographyFields(mode),
  fills: paintsSchema().optional(),
}).strict().refine(run => run.end > run.start, "Пустой диапазон текста")).max(1000);

const layout = z
  .object({
    counterAxisSpacing: z.number().nonnegative().optional(),
    strokesIncludedInLayout: z.boolean().optional(),
    itemReverseZIndex: z.boolean().optional(),
    direction: z.enum(["horizontal", "vertical", "none"]).optional(),
    gap: numberValue.optional(),
    padding: padding.optional(),
    primaryAlign: z.enum(["start", "center", "end", "space-between"]).optional(),
    counterAlign: z.enum(["start", "center", "end", "baseline"]).optional(),
    wrap: z.boolean().optional(),
  })
  .strict();

const common = {
  ...fidelityFields(),
  key: keySchema,
  parentKey: keySchema.optional(),
  order: z.number().int().nonnegative().optional(),
  name: nameSchema,
  width: dimension.optional(),
  height: dimension.optional(),
  opacity: unitValue.optional(),
  visible: z.boolean().optional(),
  effects: z.array(effectSchema()).max(32).optional(),
  effectStyleId: z.string().optional(),
};

const vectorPathsSchema = () => z.array(z.object({ windingRule: z.enum(["NONZERO", "EVENODD", "NONE"]), data: z.string().min(1).max(2000000) }).strict()).min(1).max(2000);

const containerFields = {
  ...common,
  background: colorValue.optional(),
  stroke: colorValue.optional(),
  strokeWidth: nonnegativeValue.optional(),
  cornerRadius: nonnegativeValue.optional(),
  clipContent: z.boolean().optional(),
  layout: layout.optional(),
};

export const designNodeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("polygon"), ...common, pointCount: z.number().int().min(3).max(60).optional() }).strict(),
  z.object({ type: z.literal("star"), ...common, pointCount: z.number().int().min(3).max(60).optional() }).strict(),
  z.object({ type: z.literal("booleanOperation"), ...common, booleanOperation: z.enum(["UNION", "INTERSECT", "SUBTRACT", "EXCLUDE"]) }).strict(),
  z.object({ type: z.literal("vector"), ...common, height: z.union([dimension, z.literal(0)]).optional(), vectorPaths: vectorPathsSchema(), strokeWidth: nonnegativeValue.optional(), cornerRadius: nonnegativeValue.optional(), strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"]).optional(), strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional() }).strict(),
  z.object({ type: z.literal("line"), ...common, width: nonnegativeValue.optional(), height: z.literal(0).optional(), strokeWidth: nonnegativeValue.optional(), strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"]).optional(), strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional() }).strict(),
  z.object({ type: z.literal("frame"), ...containerFields }).strict(),
  z.object({ type: z.literal("component"), ...containerFields, variant: z.record(z.string()).optional() }).strict(),
  z.object({ type: z.literal("componentSet"), ...containerFields }).strict(),
  z
    .object({
      type: z.literal("text"),
      ...common,
      content: z.string(),
      ...typographyFields(),
      textRuns: textRunsSchema().optional(),
      color: colorValue.optional(),
      textAlign: z.enum(["left", "center", "right", "justified"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("rectangle"),
      ...common,
      fill: colorValue.optional(),
      stroke: colorValue.optional(),
      strokeWidth: nonnegativeValue.optional(),
      cornerRadius: nonnegativeValue.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ellipse"),
      ...common,
      fill: colorValue.optional(),
      stroke: colorValue.optional(),
      strokeWidth: nonnegativeValue.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      ...common,
      data: z.string().min(1).max(30_000_000),
      mimeType: z.enum(["image/png", "image/jpeg"]),
      scaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional(),
      cornerRadius: nonnegativeValue.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("svg"),
      ...common,
      svg: z.string().min(1).max(2_000_000),
    })
    .strict(),
]);

export const screenSpecBaseSchema = z
  .object({
    ...fidelityFields(),
    opacity: unitValue.optional(),
    visible: z.boolean().optional(),
    strokeWidth: nonnegativeValue.optional(),
    clipContent: z.boolean().optional(),
    $schema: z.string().optional(),
    key: keySchema,
    name: nameSchema,
    type: z.literal("screen"),
    width: z.number().positive(),
    height: z.number().positive(),
    background: colorValue.optional(),
    cornerRadius: nonnegativeValue.optional(),
    effects: z.array(effectSchema()).max(32).optional(),
    effectStyleId: z.string().optional(),
    layout: layout.optional(),
    tokens: z
      .object({
        colors: z.record(hexColor).optional(),
        numbers: z.record(z.number()).optional(),
      })
      .strict()
      .optional(),
    nodes: z.array(designNodeSchema).max(2000),
  })
  .strict();

// Публичная схема render_screen намеренно не использует discriminatedUnion и
// повторно используемые Zod-объекты. Некоторые MCP-клиенты не разворачивают
// anyOf/$ref и показывают такие поля модели как unknown. Строгая проверка по
// типам узлов остаётся во внутренней screenSpecBaseSchema ниже по потоку.
const publicColor = () => z.string().min(1).max(180);
const numericString = () => z.string().max(180).regex(
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/,
  "Ожидается число (например, 28) или числовая строка (например, \"28\")",
).transform(Number);
const publicNumberToken = () => z.string().max(180).regex(
  /^\$numbers\.[^.].*$/, "Ссылка на числовой токен должна иметь вид $numbers.name",
);
const publicNumber = ({ minimum, exclusiveMinimum, maximum } = {}) => {
  let schema = z.number().finite();
  if (minimum !== undefined) schema = schema.min(minimum);
  if (exclusiveMinimum !== undefined) schema = schema.gt(exclusiveMinimum);
  if (maximum !== undefined) schema = schema.max(maximum);
  return z.union([schema, numericString().pipe(schema), publicNumberToken()])
    .describe("Число, числовая строка (преобразуется в число) или ссылка $numbers.name. Ограничения числа применяются и к числовой строке.");
};
const publicDimension = () => z.union([
  publicNumber({ exclusiveMinimum: 0 }),
  z.enum(["fill", "hug"]),
]);
const publicPadding = () => z.union([
  publicNumber({ minimum: 0 }),
  z.object({
    top: publicNumber({ minimum: 0 }).optional(),
    right: publicNumber({ minimum: 0 }).optional(),
    bottom: publicNumber({ minimum: 0 }).optional(),
    left: publicNumber({ minimum: 0 }).optional(),
  }).strict(),
]);
const publicLayout = () => z.object({
  counterAxisSpacing: z.number().nonnegative().optional(),
  strokesIncludedInLayout: z.boolean().optional(),
  itemReverseZIndex: z.boolean().optional(),
  direction: z.enum(["horizontal", "vertical", "none"]).optional(),
  gap: publicNumber().optional(),
  padding: publicPadding().optional(),
  primaryAlign: z.enum(["start", "center", "end", "space-between"]).optional(),
  counterAlign: z.enum(["start", "center", "end", "baseline"]).optional(),
  wrap: z.boolean().optional(),
}).strict();

export const publicDesignNodeSchema = z.object({
  ...fidelityFields(),
  type: z.enum(["frame", "component", "componentSet", "text", "rectangle", "ellipse", "image", "svg", "line", "vector", "polygon", "star", "booleanOperation"]),
  vectorPaths: vectorPathsSchema().optional(),
  booleanOperation: z.enum(["UNION", "INTERSECT", "SUBTRACT", "EXCLUDE"]).optional(),
  pointCount: z.number().int().min(3).max(60).optional(),
  key: z.string().min(1).max(160),
  parentKey: z.string().min(1).max(160).optional(),
  order: z.number().int().nonnegative().optional(),
  name: z.string().min(1).max(240),
  width: publicDimension().optional(),
  height: z.union([publicDimension(), z.literal(0)]).optional(),
  opacity: publicNumber({ minimum: 0, maximum: 1 }).optional(),
  visible: z.boolean().optional(),
  effects: z.array(effectSchema()).max(32).optional(),
  effectStyleId: z.string().optional(),
  background: publicColor().optional(),
  fill: publicColor().optional(),
  stroke: publicColor().optional(),
  strokeWidth: publicNumber({ minimum: 0 }).optional(),
  strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"]).optional(),
  strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional(),
  cornerRadius: publicNumber({ minimum: 0 }).optional(),
  clipContent: z.boolean().optional(),
  layout: publicLayout().optional(),
  content: z.string().optional(),
  ...typographyFields("public"),
  textRuns: textRunsSchema("public").optional(),
  color: publicColor().optional(),
  textAlign: z.enum(["left", "center", "right", "justified"]).optional(),
  data: z.string().min(1).max(30_000_000).optional(),
  mimeType: z.enum(["image/png", "image/jpeg"]).optional(),
  scaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional(),
  svg: z.string().min(1).max(2_000_000).optional(),
  variant: z.array(z.object({ property: z.string().min(1), value: z.string() }).strict()).optional(),
}).strict();

export const screenSpecPublicSchema = z.object({
  ...fidelityFields(),
  opacity: publicNumber({ minimum: 0, maximum: 1 }).optional(),
  visible: z.boolean().optional(),
  strokeWidth: publicNumber({ minimum: 0 }).optional(),
  clipContent: z.boolean().optional(),
  $schema: z.string().optional(),
  key: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  type: z.literal("screen"),
  width: z.number().positive(),
  height: z.number().positive(),
  background: publicColor().optional(),
  cornerRadius: publicNumber({ minimum: 0 }).optional(),
  effects: z.array(effectSchema()).max(32).optional(),
  effectStyleId: z.string().optional(),
  layout: publicLayout().optional(),
  tokens: z.object({
    colors: z.array(z.object({ name: z.string().min(1), value: z.string() }).strict()).optional(),
    numbers: z.array(z.object({ name: z.string().min(1), value: z.number() }).strict()).optional(),
  }).strict().optional(),
  nodes: z.array(publicDesignNodeSchema).max(2000),
}).strict();

export const screenSpecSchema = screenSpecBaseSchema.superRefine((spec, context) => {
  const keys = new Set([spec.key]);
  for (const [index, node] of spec.nodes.entries()) {
    if (keys.has(node.key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Повторяющийся key: ${node.key}`,
        path: ["nodes", index, "key"],
      });
    }
    keys.add(node.key);
  }

  const nodeKeys = new Set(spec.nodes.map((node) => node.key));
  const nodesByKey = new Map(spec.nodes.map((node) => [node.key, node]));
  const parents = new Map(spec.nodes.map((node) => [node.key, node.parentKey || spec.key]));
  for (const [index, node] of spec.nodes.entries()) {
    if (node.type !== 'text' && node.layout?.direction === 'none') {
      for (const axis of ['width', 'height']) if (node[axis] === 'hug') {
        context.addIssue({code:z.ZodIssueCode.custom,path:['nodes',index,axis],message:'Hug требует Auto Layout или TEXT; для layout.direction:none задайте числовой размер'});
      }
    }
    if (node.parentKey && node.parentKey !== spec.key && !nodeKeys.has(node.parentKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Не найден parentKey: ${node.parentKey}`,
        path: ["nodes", index, "parentKey"],
      });
    }

    if (node.parentKey && node.parentKey !== spec.key) {
      const parent = nodesByKey.get(node.parentKey);
      if (parent && !["frame", "component", "componentSet", "booleanOperation"].includes(parent.type)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Узел ${parent.key} типа ${parent.type} не может содержать дочерние узлы`,
          path: ["nodes", index, "parentKey"],
        });
      }
      if (parent?.type === "componentSet" && node.type !== "component") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Component set может содержать только component-варианты",
          path: ["nodes", index, "type"],
        });
      }
    }

    const layoutParent = !node.parentKey || node.parentKey === spec.key
      ? spec
      : nodesByKey.get(node.parentKey);
    if (layoutParent && (node.x !== undefined || node.y !== undefined) &&
        layoutParent.type !== "booleanOperation" && layoutParent.layout?.direction !== "none" && node.layoutPositioning !== "ABSOLUTE") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `x/y требуют свободной раскладки: layout.direction: "none" у родителя ${layoutParent.key} либо layoutPositioning: "ABSOLUTE" у узла ${node.key}`,
        path: ["nodes", index],
      });
    }

    const visited = new Set([node.key]);
    let parent = parents.get(node.key);
    while (parent && parent !== spec.key) {
      if (visited.has(parent)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Циклическая иерархия около key: ${node.key}`,
          path: ["nodes", index, "parentKey"],
        });
        break;
      }
      visited.add(parent);
      parent = parents.get(parent);
    }
  }

  for (const [index, node] of spec.nodes.entries()) {
    if (node.type === "booleanOperation" && spec.nodes.filter(child => child.parentKey === node.key).length < 2) context.addIssue({ code: z.ZodIssueCode.custom, message: "booleanOperation требует минимум две фигуры", path: ["nodes", index] });
    if (node.type !== "componentSet") continue;
    const variants = spec.nodes.filter((candidate) => candidate.parentKey === node.key);
    if (variants.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Component set должен содержать минимум два component-варианта",
        path: ["nodes", index],
      });
    }
  }
});

function resolveTokenReferences(value, tokens, path = "spec") {
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveTokenReferences(item, tokens, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return value;
  if (Object.keys(value).length === 1 && typeof value.token === "string") {
    const [group, ...rest] = value.token.split(".");
    const name = rest.join(".");
    if (!name || !["colors", "numbers"].includes(group)) {
      throw new Error(`Некорректная ссылка на токен ${value.token} в ${path}`);
    }
    const resolved = tokens?.[group]?.[name];
    if (resolved === undefined) throw new Error(`Не найден токен ${value.token} в ${path}`);
    return resolved;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "tokens" ? item : resolveTokenReferences(item, tokens, `${path}.${key}`),
    ]),
  );
}

export function resolveScreenSpecTokens(input) {
  const parsed = screenSpecSchema.parse(input);
  const resolved = resolveTokenReferences(parsed, parsed.tokens);
  return screenSpecSchema.parse(resolved);
}

export function normalizeScreenSpec(input) {
  const publicResult = screenSpecPublicSchema.safeParse(input);
  const spec = resolveScreenSpecTokens(
    publicResult.success ? adaptPublicScreenSpec(publicResult.data) : input,
  );
  const byParent = new Map();
  for (const node of spec.nodes) {
    const parentKey = node.parentKey || spec.key;
    const list = byParent.get(parentKey) || [];
    list.push(node);
    byParent.set(parentKey, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  }
  const buildChildren = (parentKey) =>
    (byParent.get(parentKey) || []).map((node) => {
      const { parentKey: _parentKey, order: _order, ...rest } = node;
      if (node.type === "frame" || node.type === "component" || node.type === "componentSet" || node.type === "booleanOperation") {
        return { ...rest, children: buildChildren(node.key) };
      }
      return rest;
    });
  const { nodes: _nodes, ...root } = spec;
  return { ...root, children: buildChildren(spec.key) };
}

function publicTokenValue(value) {
  return typeof value === "string" && /^\$(colors|numbers)\.[^.].*/.test(value)
    ? { token: value.slice(1) }
    : value;
}

function publicLayoutToInternal(value) {
  if (!value) return value;
  const paddingValue = value.padding;
  const padding = paddingValue && typeof paddingValue === "object"
    ? Object.fromEntries(Object.entries(paddingValue).map(([key, item]) => [key, publicTokenValue(item)]))
    : publicTokenValue(paddingValue);
  return {
    ...value,
    gap: publicTokenValue(value.gap),
    padding,
  };
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function adaptPublicScreenSpec(spec) {
  const tokens = spec.tokens
    ? {
        colors: Object.fromEntries((spec.tokens.colors || []).map(({ name, value }) => [name, value])),
        numbers: Object.fromEntries((spec.tokens.numbers || []).map(({ name, value }) => [name, value])),
      }
    : undefined;
  const nodes = spec.nodes.map((node) => withoutUndefined({
      ...node,
      width: publicTokenValue(node.width),
      height: publicTokenValue(node.height),
      opacity: publicTokenValue(node.opacity),
      background: publicTokenValue(["frame", "component", "componentSet"].includes(node.type) ? node.background ?? node.fill : node.background),
      fill: ["frame", "component", "componentSet"].includes(node.type) ? undefined : publicTokenValue(node.fill),
      stroke: publicTokenValue(node.stroke),
      strokeWidth: publicTokenValue(node.strokeWidth),
      cornerRadius: publicTokenValue(node.cornerRadius),
      layout: publicLayoutToInternal(node.layout),
      fontSize: publicTokenValue(node.fontSize),
      lineHeight: publicTokenValue(node.lineHeight),
      letterSpacing: publicTokenValue(node.letterSpacing),
      textRuns: node.textRuns?.map(run => ({
        ...run,
        fontSize: publicTokenValue(run.fontSize),
        lineHeight: publicTokenValue(run.lineHeight),
        letterSpacing: publicTokenValue(run.letterSpacing),
      })),
      color: publicTokenValue(node.color),
      variant: node.variant ? Object.fromEntries(node.variant.map(({ property, value }) => [property, value])) : undefined,
    }));
  return {
    ...spec,
    background: publicTokenValue(spec.background),
    opacity: publicTokenValue(spec.opacity),
    strokeWidth: publicTokenValue(spec.strokeWidth),
    cornerRadius: publicTokenValue(spec.cornerRadius),
    layout: publicLayoutToInternal(spec.layout),
    tokens,
    nodes,
  };
}

export const renderScreenInputSchema = {
  operationId: z.string().uuid().optional().describe("UUID запроса: повтор того же ID не отправляет запись снова; новая намеренная правка требует нового ID."),
  parentId: z.string().min(1).max(160).optional().describe("Существующий PAGE, FRAME или SECTION на активной странице. Без поля используется текущая PAGE. Под FRAME создаётся FRAME-обёртка, иначе SECTION."),
  spec: screenSpecPublicSchema,
  dryRun: z.boolean().optional().describe("Проверить спецификацию, свойства и загрузку шрифтов без создания узлов. Не проверяет итоговый рендер SVG, клики или визуальное совпадение."),
  replace: z.boolean().optional(),
  sectionName: nameSchema.optional(),
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  screenshot: z.boolean().optional(),
  screenshotScale: z.number().min(0.5).max(4).optional(),
  fileKey: z.string().min(1).optional().describe(fileKeyDescription),
};

export const renderScreenSchema = z.object({
  ...renderScreenInputSchema,
  spec: screenSpecBaseSchema,
}).strict();

const renderScreenPublicSchema = z.object(renderScreenInputSchema).strict();

export function parseRenderScreenInput(input) {
  const parsed = renderScreenPublicSchema.parse(input);
  return renderScreenSchema.parse({ ...parsed, spec: adaptPublicScreenSpec(parsed.spec) });
}

const patchSetSchema = z
  .object({
    ...fidelityFields(),
    scaleFactor: z.number().finite().positive().optional().describe("Абсолютный нативный масштаб INSTANCE; rescale выполняется перед width/height. Отношение к текущему масштабу должно быть 0.01–100 для обратимого отката."),
    vectorPaths: vectorPathsSchema().optional(),
    strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"]).optional(),
    strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional(),
    booleanOperation: z.enum(["UNION", "INTERSECT", "SUBTRACT", "EXCLUDE"]).optional(),
    pointCount: z.number().int().min(3).max(60).optional(),
    name: nameSchema.optional(),
    content: z.string().optional(),
    ...typographyFields("concrete"),
    textRuns: textRunsSchema("concrete").optional(),
    textAlign: z.enum(["left", "center", "right", "justified"]).optional(),
    effects: z.array(effectSchema()).max(32).optional(),
    effectStyleId: z.string().optional(),
    width: concreteDimension.optional(),
    height: z.union([concreteDimension, z.literal(0)]).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    visible: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    background: hexColor.optional(),
    color: hexColor.optional(),
    stroke: hexColor.optional(),
    strokeWidth: z.number().nonnegative().optional(),
    cornerRadius: z.number().nonnegative().optional(),
    gap: z.number().optional(),
    clipContent: z.boolean().optional(),
    padding: concretePadding.optional(),
    layout: z.object({
      counterAxisSpacing: z.number().nonnegative().optional(),
      strokesIncludedInLayout: z.boolean().optional(),
      itemReverseZIndex: z.boolean().optional(),
      direction: z.enum(["horizontal", "vertical", "none"]).optional(),
      gap: z.number().optional(),
      padding: concretePadding.optional(),
      primaryAlign: z.enum(["start", "center", "end", "space-between"]).optional(),
      counterAlign: z.enum(["start", "center", "end", "baseline"]).optional(),
      wrap: z.boolean().optional(),
    }).strict().optional(),
    componentProperties: z.record(z.union([z.string(), z.boolean()])).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Патч не должен быть пустым");

export const patchNodesInputSchema = {
  operationId: z.string().uuid().optional(),
  patches: z
    .array(
      z
        .object({
          key: keySchema.optional(),
          id: z.string().min(1).max(160).optional(),
          set: patchSetSchema.optional(),
          append: z.array(designNodeSchema).min(1).max(200).optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (Boolean(value.key) === Boolean(value.id)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Укажите ровно один target: key или id" });
          }
          if (!value.set && !value.append) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Укажите set и/или append" });
          }
          if (!value.append) return;
          const keys = new Set();
          const byKey = new Map(value.append.map((node) => [node.key, node]));
          for (const [index, node] of value.append.entries()) {
            if (keys.has(node.key)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Повторяющийся append key: ${node.key}`,
                path: ["append", index, "key"],
              });
            }
            keys.add(node.key);
          }
          for (const [index, node] of value.append.entries()) {
            if (node.parentKey && !keys.has(node.parentKey)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Не найден append parentKey: ${node.parentKey}`,
                path: ["append", index, "parentKey"],
              });
            }
            const parent = byKey.get(node.parentKey);
            if (parent && !["frame", "component", "componentSet", "booleanOperation"].includes(parent.type)) {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Родитель append должен быть контейнером", path: ["append", index, "parentKey"] });
            }
            if (parent?.type === "componentSet" && node.type !== "component") {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Component set может содержать только component-варианты", path: ["append", index, "parentKey"] });
            }
            const visited = new Set([node.key]);
            let cursor = node.parentKey;
            while (cursor && byKey.has(cursor)) {
              if (visited.has(cursor)) {
                context.addIssue({ code: z.ZodIssueCode.custom, message: `Циклическая иерархия append около key: ${node.key}`, path: ["append", index, "parentKey"] });
                break;
              }
              visited.add(cursor);
              cursor = byKey.get(cursor).parentKey;
            }
            if (node.type === "booleanOperation" && value.append.filter(child => child.parentKey === node.key).length < 2) context.addIssue({ code: z.ZodIssueCode.custom, message: "booleanOperation требует минимум две фигуры", path: ["append", index] });
            if (node.type === "componentSet" && value.append.filter((child) => child.parentKey === node.key).length < 2) {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Component set должен содержать минимум два варианта", path: ["append", index] });
            }
          }
        }),
    )
    .min(1)
    .max(200),
  ignoreMissing: z.boolean().optional(),
  screenshotKey: keySchema.optional(),
  screenshotScale: z.number().min(0.5).max(4).optional(),
  fileKey: z.string().min(1).optional().describe(fileKeyDescription),
};
export const patchNodesSchema = z.object(patchNodesInputSchema).strict().superRefine((input, context) => {
  const keys = new Set();
  for (const [index, patch] of input.patches.entries()) {
    for (const [childIndex, node] of (patch.append || []).entries()) {
      if (keys.has(node.key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Повторяющийся append key в пакете: ${node.key}`, path: ["patches", index, "append", childIndex, "key"] });
      }
      keys.add(node.key);
      // append has no token dictionary; unresolved token objects must not reach Plugin API.
      function checkTokens(value, path) {
        if (!value || typeof value !== "object") return;
        if (typeof value.token === "string") {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "В append используйте конкретные значения вместо ссылок на токены", path });
        }
        for (const [key, child] of Object.entries(value)) checkTokens(child, [...path, key]);
      }
      checkTokens(node, ["patches", index, "append", childIndex]);
    }
  }
});

export const inspectSelectionInputSchema = {
  nodeId: z.string().min(1).max(160).optional(),
  nodeIds: z.array(z.string().min(1).max(160)).min(1).max(50).optional().describe('Массив из 1–50 ID. Не объединяйте разные ID в строку nodeId. Передавайте только nodeId или только nodeIds.'),
  detail: z.enum(["compact", "full"]).optional().describe('compact по умолчанию: структура и основные свойства. Для точных шрифтов, цветов, textRuns и сравнения оформления сразу передавайте full.'),
  depth: z.number().int().min(0).max(8).optional().describe("Глубина от запрошенного узла: целое 0–8, по умолчанию 3; 0 — без детей. Более глубокие ветки дочитывайте отдельными вызовами по nodeId из coverage.unread, сохраняя depth ≤ 8."),
  maxNodes: z.number().int().min(1).max(1000).optional().describe("Общий лимит узлов на вызов: целое 1–1000, по умолчанию 200. При неполном обходе дочитывайте узлы из coverage.unread отдельными вызовами."),
  screenshot: z.boolean().optional(),
  screenshotScale: z.number().min(0.5).max(4).optional(),
  includeFiles: z.boolean().optional(),
  fileKey: z.string().min(1).optional().describe(fileKeyDescription),
};
export const inspectSelectionSchema = z.object(inspectSelectionInputSchema).strict().refine(
  (input) => !(input.nodeId && input.nodeIds), "Укажите nodeId или nodeIds, но не оба поля",
);

export const useComponentInputSchema = {
  sourceKey: keySchema.optional(),
  sourceId: z.string().min(1).max(160).optional(),
  libraryKey: z.string().min(1).optional(),
  librarySetKey: z.string().regex(/^[a-f0-9]{40}$/).optional().describe("Exact published component-set key; requires exact selected libraryKey and a non-empty exact variant selector. No direct import fallback."),
  parentKey: keySchema.optional(),
  parentId: z.string().min(1).max(160).optional(),
  key: keySchema,
  name: nameSchema.optional(),
  variant: z.record(z.string()).optional(),
  componentProperties: z.record(z.union([z.string(), z.boolean()])).optional(),
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  screenshot: z.boolean().optional(),
  screenshotScale: z.number().min(0.5).max(4).optional(),
  dryRun: z.boolean().optional(),
  fileKey: z.string().min(1).optional().describe(fileKeyDescription),
};

export const useComponentSchema = z
  .object(useComponentInputSchema)
  .strict()
  .superRefine((value, context) => {
    if ([value.sourceKey, value.sourceId, value.libraryKey].filter(Boolean).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Укажите ровно один источник: sourceKey, sourceId или libraryKey",
      });
    }
    if (value.librarySetKey !== undefined) {
      if (!/^[a-f0-9]{40}$/.test(value.libraryKey ?? "") || value.sourceKey || value.sourceId) context.addIssue({ code: z.ZodIssueCode.custom, message: "librarySetKey requires the exact child libraryKey and no local source" });
      if (!value.variant || !Object.keys(value.variant).length || Object.entries(value.variant).some(([key, item]) => !key.trim().length || !item.trim().length)) context.addIssue({ code: z.ZodIssueCode.custom, message: "librarySetKey requires a non-empty exact variant selector with non-empty names and values" });
    }
    if (value.parentKey && value.parentId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Укажите parentKey или parentId, но не оба поля" });
  });
