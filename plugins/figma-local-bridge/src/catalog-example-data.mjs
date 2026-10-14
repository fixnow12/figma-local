/** Synchronous, detached example data shared by capture, verification and output. */
import {normalizeComponentVariantGroups} from './component-definitions.mjs';
export function captureCatalogExampleNode(figma,node,children,childIndex){
  const gaps=[];
  let definitionsRead=false,definitions,definitionsError;
  const modernDefinitions=()=>{
    if(!definitionsRead){definitionsRead=true;try{definitions=node.componentPropertyDefinitions;}catch(error){definitionsError=error;}}
    if(definitionsError)throw definitionsError;
    return definitions;
  };
  const safe=(node,field)=>{
    try {
      const value=node.type==='COMPONENT_SET'&&field==='variantGroupProperties'?normalizeComponentVariantGroups(modernDefinitions()):
        node.type==='COMPONENT_SET'&&field==='componentPropertyDefinitions'?modernDefinitions():node[field];
      return value===figma.mixed?'MIXED':value;
    } catch(error){gaps.push({nodeId:node.id,field,reason:'property-unavailable',message:String(error.message||error)});return undefined;}
  };
  const fields=['visible','x','y','width','height','absoluteBoundingBox','relativeTransform','rotation','constraints','opacity','fills','strokes','strokeWeight','strokeAlign','strokeTopWeight','strokeBottomWeight','strokeLeftWeight','strokeRightWeight','dashPattern','cornerRadius','topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius','cornerSmoothing','clipsContent','effects','blendMode','isMask','maskType','fillStyleId','strokeStyleId','effectStyleId','gridStyleId','boundVariables','explicitVariableModes','layoutMode','layoutWrap','layoutSizingHorizontal','layoutSizingVertical','layoutPositioning','itemSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','primaryAxisAlignItems','counterAxisAlignItems','counterAxisSpacing','strokesIncludedInLayout','itemReverseZIndex','minWidth','maxWidth','minHeight','maxHeight','reactions','componentPropertyReferences','vectorPaths','booleanOperation','pointCount','strokeCap','strokeJoin','componentProperties','overrides','variantProperties','variantGroupProperties','componentPropertyDefinitions','remote','key','description'];
  const textFields=['characters','fontName','fontSize','lineHeight','letterSpacing','textCase','textDecoration','paragraphSpacing','paragraphIndent','listOptions','listSpacing','indentation','textStyleId','textAlignHorizontal','textAlignVertical','textAutoResize','hasMissingFont'];
  const value={id:node.id,parentId:node.parent?.id??null,childIds:(children??('children'in node?node.children:[])).map(child=>child.id),childIndex:childIndex??(node.parent?.children?.findIndex(child=>child.id===node.id)??-1),type:node.type,name:node.name,properties:{}};
    for(const field of fields)if(field in node||node.type==='COMPONENT_SET'&&field==='variantGroupProperties'){
      if(field==='componentPropertyDefinitions'&&node.type==='COMPONENT'&&node.parent?.type==='COMPONENT_SET')continue;
      const item=safe(node,field);if(item!==undefined)value.properties[field]=item;
    }
    if(node.type==='TEXT'){
      for(const field of textFields)if(field in node){const item=safe(node,field);if(item!==undefined)value.properties[field]=item;}
      for(const [label,segmentFields] of [['textSegments',['fontName','fontSize','lineHeight','letterSpacing','textCase','textDecoration','paragraphSpacing','paragraphIndent','fills','textStyleId','fillStyleId','boundVariables']],['hyperlinks',['hyperlink']]]){
        try {value.properties[label]=node.getStyledTextSegments(segmentFields);} catch(error){gaps.push({nodeId:node.id,field:label,reason:'property-unavailable',message:String(error.message||error)});}
      }
    }
  return JSON.parse(JSON.stringify({value,gaps}));
}
