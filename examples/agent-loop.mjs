// Bounded host loop: the host enforces decisions and owns any real actions.
import { Supervisor, detectStuck } from '../dist/core.js';
import { MockProvider } from '../dist/providers.js';
const supervisor = new Supervisor(new MockProvider());
const requirements = ['readme','tests','build','license','security'].map(id=>({id,description:`Include ${id}`}));
const steps=[];
for(let attempt=0;attempt<3;attempt++) {
  const currentResult=requirements.slice(0,attempt===0?3:5).map(r=>`[done:${r.id}]`).join(' ');
  steps.push({action:'revise',input:'release',result:currentResult,progress:attempt>0});
  if(detectStuck({steps}).stuck) { console.log('Host stops for review'); break; }
  const result=await supervisor.check({task:'Prepare release',requirements,currentResult,evidence:'Synthetic fixture'});
  console.log(JSON.stringify(result));
  if(result.decision==='finish'||result.decision==='review') break;
}
