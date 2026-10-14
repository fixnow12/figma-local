// Shared by resource output and example capture/verification. Serialized with
// catalog operations; no legacy getter or source lookup occurs in this function.
export function normalizeComponentVariantGroups(definitions){
  if(!definitions||typeof definitions!=='object'||Array.isArray(definitions))throw Error('Invalid componentPropertyDefinitions record');
  const groups=[];
  for(const [name,definition] of Object.entries(definitions)){
    if(!name||!definition||typeof definition!=='object'||Array.isArray(definition)||!['VARIANT','TEXT','BOOLEAN','INSTANCE_SWAP','SLOT'].includes(definition.type))throw Error('Invalid component property definition');
    if(definition.type==='SLOT'){
      // SLOT is not a variant axis. Validate returned metadata without deleting
      // the definition; capture preserves the authoritative record unchanged.
      if(Object.hasOwn(definition,'description')&&definition.description!==null&&typeof definition.description!=='string')throw Error('Invalid SLOT description: '+name);
      if(Object.hasOwn(definition,'preferredValues')&&(!Array.isArray(definition.preferredValues)||Array.from(definition.preferredValues).some(value=>!value||typeof value!=='object'||Array.isArray(value)||!['COMPONENT','COMPONENT_SET'].includes(value.type)||typeof value.key!=='string'||!value.key.length)))throw Error('Invalid SLOT preferredValues: '+name);
      if(Object.hasOwn(definition,'defaultValue')&&!['string','boolean'].includes(typeof definition.defaultValue))throw Error('Invalid SLOT defaultValue: '+name);
      if(Object.hasOwn(definition,'variantOptions'))throw Error('Invalid SLOT variantOptions: '+name);
      if(Object.hasOwn(definition,'slotSettings')){
        const settings=definition.slotSettings;
        if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Invalid SLOT slotSettings: '+name);
        for(const field of ['stretchChildOnInsert','displayEmptyByDefault','allowPreferredValuesOnly'])if(Object.hasOwn(settings,field)&&typeof settings[field]!=='boolean')throw Error('Invalid SLOT '+field+': '+name);
        for(const field of ['minChildren','maxChildren'])if(Object.hasOwn(settings,field)&&settings[field]!==null&&(!Number.isInteger(settings[field])||settings[field]<0))throw Error('Invalid SLOT '+field+': '+name);
        if(settings.minChildren!=null&&settings.maxChildren!=null&&settings.minChildren>settings.maxChildren)throw Error('Invalid SLOT child count range: '+name);
      }
    }
    if(definition.type!=='VARIANT')continue;
    const values=definition.variantOptions;
    if(!Array.isArray(values)||!values.length||values.some(value=>typeof value!=='string'||!value.length)||new Set(values).size!==values.length||typeof definition.defaultValue!=='string'||!values.includes(definition.defaultValue))throw Error('Invalid VARIANT options/default: '+name);
    groups.push([name,{values:[...values]}]);
  }
  if(!groups.length)throw Error('Component set has no validated VARIANT definitions');
  return Object.fromEntries(groups);
}
