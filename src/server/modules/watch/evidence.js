export const slotMs=5000;
const maxGap=6500;

// Credit only complete, uninterrupted server-clock buckets between verified observations.
export function advanceEvidence(previous,next) {
  const result={...next,from:next.at,lastSlot:Math.floor(next.at/slotMs)-1};
  if (!previous || previous.mediaId!==next.mediaId || previous.epoch!==next.epoch) return {state:result,slots:[]};
  const elapsed=(next.at-previous.at)/1000;
  const progressed=next.position-previous.position;
  if (elapsed<1.4) return {state:previous,slots:[]};
  if (elapsed>maxGap/1000 || progressed<elapsed-.55 || progressed>elapsed+.8) return {state:result,slots:[]};
  result.from=previous.from;
  const first=Math.max(previous.lastSlot+1,Math.ceil(result.from/slotMs));
  const stop=Math.floor(next.at/slotMs);
  const slots=[];
  for(let slot=first;slot<stop;slot++)slots.push(slot);
  result.lastSlot=Math.max(previous.lastSlot,stop-1);
  return {state:result,slots};
}

