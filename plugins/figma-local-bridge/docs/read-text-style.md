# read_text_style v1: scoped native TEXT style evidence

Additive read-only MCP tool. This route adds `src/read-text-style.mjs` and its registration in `src/server.mjs`. The integrated portable-suite candidate also changes other schemas, plugin and broker sources; their actual runtime fingerprints must be checked as a complete set. The existing generated-code transport dispatches this typed operation with `mutating:false`. No generic code input, import, assignment, font loading, canvas mutation or page/selection change is exposed.

## Request

```json
{"fileKey":"exact-file-key","rootId":"exact-native-root","styleId":"opaque-native-style-id","nodeIds":["exact-TEXT-id"]}
```

All four fields are required. Unknown fields fail in the public MCP schema and in the exported builder. 1–20 unique nodes; IDs 1–512 characters; fileKey 1–160. Root must be INSTANCE, FRAME, COMPONENT, COMPONENT_SET or SECTION. Every supplied node must be TEXT, below that exact native root, on its actual owning PAGE (parent walk with reciprocal child membership, document membership, maximum 256 ancestors). Active PAGE is not taken as ownership evidence and is never switched. This proves the requested nodes only, not an exhaustive consumer list.

Each requested TEXT must have the exact nonmixed textStyleId. Empty text and mixed textStyleId are unsupported and fail entirely. Native `getStyledTextSegments(['textStyleId'])` must cover the full 1–10,000 UTF-16 code units of each node with contiguous, nonoverlapping integer ranges and exact characters; boundaries may not split surrogate pairs. Maximum 1,000 ranges/node. Range textStyleId must agree with node textStyleId and request. Characters are checked internally but excluded from returned evidence. A node/typography/segment mirror in another inspection is not an additional independent native use: this tool returns one node reference and each observed native range.

## Successful result

Body: `schemaVersion:1`, `kind:'referenced-text-style'`, `operationStatus:'read'`, exact fileKey/rootId, actual owning pageId, `style`, `uses`, `dependencies`, `dependencySemantics:'direct-binding-identities-and-collection-modes'`, `complete:true`, complete counted coverage, `unresolved:[]`.

`style` contains actual native `id`, independently read 40-hex published `key`, `type:'TEXT'`, boolean `remote`, name and explicit versioned `definition`. Keys are never parsed from IDs. Local and remote TEXT styles both work if already referenced and readable by `getStyleByIdAsync`; no importing is attempted. A null result, throwing getter or unsupported native shape fails.

Versioned definition includes fontName (family/style plus optional finite four-ASCII-axis variationSettings), fontSize, textDecoration, textCase, lineHeight, letterSpacing, leadingTrim, paragraphIndent, paragraphSpacing, textWrapStyle, listSpacing, hangingPunctuation and hangingList. All definition getters are mandatory, even when their value is zero/false/AUTO. Old Plugin API builds without these getters fail; no defaults fabricate completeness. Style name is metadata; descriptions/documentation links and mutation methods are outside visual definition v1. Unknown structured fields in FontName, spacing, aliases and range records fail rather than disappearing during JSON serialization. Native top-level objects have API methods/metadata and are deliberately projected to this explicit v1 contract; future typography API fields require a versioned extension, not a claim of universal forward completeness.

`boundVariables` is the exact direct map of supported native VariableBindableTextField aliases. Documented optional absence means an empty map. Unknown fields, malformed aliases or unread getters fail. fontFamily/fontStyle require STRING; fontWeight/fontSize/letterSpacing/lineHeight/paragraphSpacing/paragraphIndent require FLOAT. Every unique direct alias is read by actual native ID; native variable ID/key/type/collection ID and actual collection ID/key/modes/defaultModeId are verified and returned. Native IDs remain file scoped.

**Dependency scope:** complete means every direct binding in this captured style definition has identity/type/collection/mode metadata. It does not mean variable valuesByMode, transitive value aliases, selected-mode computed values, font bytes, effective node override values, or pixel fidelity were resolved. It must never be promoted to that stronger claim. Existing node alias proofs do not substitute for these style dependencies. A future consumer must close any value dependencies it needs separately.

The final read rechecks style and native dependencies, consumer references/ranges/characters, ancestry, unchanged active page and file. This detects observed drift but is not an atomic lock or permanent freshness guarantee. Consumers must bind and compare the exact new raw response bytes and contemporaneous inspection evidence.

## Failure semantics

Unavailable/wrong native identity/type/key, missing dependencies, mixed or incomplete ranges, broken ancestry, getters throwing, observed drift, unsupported fields and consumed records carrying errors/missing/unread/warnings/fidelityWarnings, complete:false, coverage failure, truncation, isError:true or ok/success:false all reject the operation. No successful partial `complete:true` response is returned. Existing read-only generated transport marks a known exception `not_applied`; transport-unknown outcomes remain unknown through normal Bridge handling and must never count as successful evidence.

## Fingerprints and deployment

sourceRevision hashes all top-level src mjs/cjs and therefore covers both new builder and server registration. This route itself uses the existing generated-code transport, but the integrated candidate includes plugin/broker changes and new capability strings. Its source, broker and plugin hashes are computed from the final shipped sources; this document does not certify an installed build. Current status/old fingerprints cannot prove this new capability: after an independently approved future deployment, enumerate the typed tool on the new MCP source revision and capture fresh raw scoped responses. This patch was tested only with native API mocks, not installed or executed against actual Figma.

## Official API references

- [TextStyle native fields](https://developers.figma.com/docs/plugins/api/TextStyle/)
- [PluginAPI getStyleByIdAsync](https://developers.figma.com/docs/plugins/api/figma/#getstylebyidasync)
- [VariableBindableTextField](https://developers.figma.com/docs/plugins/api/VariableBindableTextField/)
- [FontName](https://developers.figma.com/docs/plugins/api/FontName/)
- [Official Plugin API type definitions](https://github.com/figma/plugin-typings/blob/master/plugin-api.d.ts)
