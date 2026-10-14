// Portable exact-range paragraph restoration; temporary styles never persist.
export async function applyExactParagraphRanges(figma,node,runs=[],options={}){
 // Native paragraph setters expand to whole paragraphs. A temporary local
 // TextStyle applies to exact characters; deleting it retains resolved values.
 // Clearing textStyleId instead would discard the per-character paragraph value.
 // Forward mutations supply a tracked font loader and cancellation check.
 // Restoration intentionally uses the defaults: rollback must run even when
 // the timed-out forward operation has been cancelled.
 const loadFont=options.loadFont||((font)=>figma.loadFontAsync(font));
 const check=options.check||(()=>{});
 const fields=['fontName','fontSize','lineHeight','letterSpacing','textCase','textDecoration','paragraphSpacing','paragraphIndent','listSpacing','textWrapStyle'];
 const createdStyleIds=[],removedStyleIds=[];
 for(const run of runs){
  check();
  const requested=['paragraphSpacing','paragraphIndent'].filter(field=>run[field]!==undefined);
  if(!requested.length)continue;
  const segments=node.getStyledTextSegments([...fields,'boundVariables'],run.start,run.end);
  for(const segment of segments){
   check();
   if(requested.every(field=>segment[field]===run[field]))continue;
   const values=Object.fromEntries(fields.filter(field=>segment[field]!==undefined).map(field=>[field,segment[field]]));
   for(const field of requested)values[field]=run[field];
   for(const field of ['leadingTrim','hangingPunctuation','hangingList'])if(node[field]!==undefined){if(typeof node[field]==='symbol')throw Error('Cannot preserve mixed '+field+' while applying paragraph range');values[field]=node[field];}
   await loadFont(values.fontName);
   check();
   const aliases=[];
   for(const [field,alias]of Object.entries(segment.boundVariables||{}))if(alias?.type==='VARIABLE_ALIAS'){
    const variable=await figma.variables.getVariableByIdAsync(alias.id);
    check();
    if(!variable)throw Error('Missing paragraph range variable '+alias.id);
    aliases.push([field,variable]);
   }
   check();
   const style=figma.createTextStyle();createdStyleIds.push(style.id);
   try{
    style.name='Временное сохранение интервала';
    for(const [field,value]of Object.entries(values))style[field]=value;
    // Rebinding the node after style removal makes Figma regenerate the old
    // paragraph-wide style. Keep aliases on the temporary style itself.
    for(const [field,variable]of aliases)style.setBoundVariable(field,variable);
    check();
    await node.setRangeTextStyleIdAsync(segment.start,segment.end,style.id);
   }finally{
    style.remove();removedStyleIds.push(style.id);
    if(await figma.getStyleByIdAsync(style.id)!==null)throw Error('Temporary paragraph style was not removed');
   }
   check();
   const observed=node.getStyledTextSegments([...requested,'boundVariables'],segment.start,segment.end);
   if(!observed.length||observed.some(part=>requested.some(field=>part[field]!==run[field])||aliases.some(([field,variable])=>part.boundVariables?.[field]?.id!==variable.id)))throw Error('Exact paragraph range verification failed');
  }
 }
 return {createdStyleIds,removedStyleIds};
}
