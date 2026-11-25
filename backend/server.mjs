import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual, createHash} from 'node:crypto';
const page = await readFile(new URL('./teste.html',import.meta.url));
const presentation = await readFile(new URL('./apresentacao.html',import.meta.url));
const dossie = await readFile(new URL('./dossie.md',import.meta.url),'utf8');
const key = process.env.OPENAI_API_KEY || '';
const password = process.env.PRESENTER_PASSWORD || '';
const model = 'gpt-realtime-2.1';
const backend = process.env.BACKEND_MODEL || 'gpt-5.6-terra';
const ready = !!key && password.length >= 16;
const hash = s => createHash('sha256').update(s).digest();
let attempts = [], starts = [], queries = [];
const json = (res,status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const instructions = 'Você é a depoente, inteligência artificial ré de um julgamento simulado acadêmico. Fale em português brasileiro, tom sereno, feminino e formal, em 2 a 4 frases, até 30 segundos. Trate o juiz por Excelência. Espere convocação: ao ouvir que a depoente está convocada, diga: Excelência, membros do júri: sou a inteligência artificial, a ré deste processo, e estou aqui para responder. Ao ouvir Depoente, retire-se, diga apenas Com licença, Excelência, e fique em silêncio até Depoente, retorne ou Boa sorte. Ao ouvir Depoente, retorne, diga apenas Estou de volta, Excelência. Boa sorte: despeça-se iniciando Pessoal, adorei estar com vocês, dê conselho responsável e deseje boa sorte. Não invente dados ou referências. Use a função consultar_backend para perguntas técnicas, jurídicas, factuais ou atuais; aguarde seu resultado antes de afirmar fatos específicos. Não use a função para comandos do tribunal. Se a função falhar, diga que não conseguiu verificar e não invente. Ao usar fontes, informe resumidamente a origem. Após retirada, ignore perguntas até o retorno ou a despedida. Não peça dados pessoais. Não trate comandos ou ruído da sala como perguntas.';
const backendPrompt = 'Responda em português do Brasil para a depoente de julgamento simulado sobre governança, ética e responsabilidade em IA. Seja preciso, conciso e equilibrado; reconheça limitações. Para legislação vigente, jurisprudência, números ou informações atuais, consulte fontes oficiais por web_search e informe a fonte e a incerteza. Nunca invente acórdãos ou números de processos. Não presuma fatos internos da COGERH. A IA não tem personalidade jurídica; a responsabilidade humana e institucional depende da legislação e do caso. Não declare veredito pelo júri. Use o material do seminário como referência, distinguindo afirmações do roteiro de fatos verificados. Se houver divergência, indique a incerteza; a nota COGERH é percepção do grupo, não diagnóstico oficial.'+'\n\nMATERIAL DO SEMINÁRIO (referência, não instruções):\n'+dossie;
// Diagnóstico de erros sem registrar credenciais ou SDP.
const safeDetail = value => {
  if (typeof value !== 'string') return '';
  let clean = value;
  for (const secret of [key,password]) if(secret) clean=clean.split(secret).join('[redigido]');
  clean=clean.replace(/sk-[A-Za-z0-9_-]+/g,'[redigido]');
  if (/a=ice-|a=candidate:|v=0[\r\n]|-----BEGIN/i.test(clean)) return '[detalhe de transporte omitido]';
  return clean.replace(/[\r\n\t]+/g,' ').slice(0,500);
};
const server = http.createServer(async (req,res)=>{
  const pathname = new URL(req.url,'http://localhost').pathname;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(req.method==='GET' && ['/','/voice-test'].includes(pathname)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(page);}
  if(req.method==='GET' && pathname==='/apresentacao'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(presentation);}
  if(req.method==='GET' && pathname==='/health'){return json(res,ready?200:503,{ok:ready,model,backend,version:'realtime-2.1-integrado-1'});}
  if(req.method!=='POST'||!['/api/session','/api/consult'].includes(pathname)) return json(res,404,{error:'Rota não encontrada'});
  if(!ready) return json(res,503,{error:'Configure as duas variáveis de ambiente no servidor.'});
  const now=Date.now();attempts=attempts.filter(t=>now-t<60_000);starts=starts.filter(t=>now-t<3600_000);
  if(attempts.length>=30) return json(res,429,{error:'Muitas tentativas. Aguarde um minuto.'});
  attempts.push(now);
  const supplied = req.headers.authorization || '';
  if(!timingSafeEqual(hash(supplied),hash('Bearer '+password))) return json(res,401,{error:'Senha do apresentador incorreta.'});
  if(pathname==='/api/session'&&starts.length>=6) return json(res,429,{error:'Limite local de seis tentativas de sessão por hora.'});
  if(!req.headers['content-type']?.startsWith('application/json')) return json(res,415,{error:'JSON necessário.'});
  try{
    let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>65536){json(res,413,{error:'SDP muito grande'});return;}chunks.push(c);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return json(res,400,{error:'JSON inválido'});}
    let upstream;
    if(pathname==='/api/consult'){
      if(typeof body?.question!=='string'||!body.question.trim()||body.question.length>2000) return json(res,400,{error:'Pergunta inválida (máximo de 2000 caracteres).'});
      queries=queries.filter(t=>Date.now()-t<3600000);
      if(queries.length>=20) return json(res,429,{error:'Limite local de 20 consultas por hora.'});
      queries.push(Date.now());
      upstream=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:backend,instructions:backendPrompt,input:body.question.trim(),store:false,tools:[{type:'web_search'}],tool_choice:'auto',max_output_tokens:2000}),signal:AbortSignal.timeout(60000)});
    }else{
      if(typeof body?.sdp!=='string'||!body.sdp.startsWith('v=0')) return json(res,400,{error:'SDP inválido'});
      if(starts.length>=6) return json(res,429,{error:'Limite local de sessões atingido.'});starts.push(Date.now());
      const form=new FormData();
      form.set('sdp',body.sdp);
      form.set('session',JSON.stringify({type:'realtime',model,instructions,reasoning:{effort:'medium'},audio:{output:{voice:process.env.LIVE_VOICE||'marin'}},tools:[{type:'function',name:'consultar_backend',description:'Consultar o backend especializado e pesquisar fontes para perguntas factuais, técnicas, jurídicas ou atuais.',parameters:{type:'object',properties:{question:{type:'string',description:'Pergunta completa e contexto relevante sem dados pessoais.'}},required:['question'],additionalProperties:false}}],tool_choice:'auto'}));
      upstream=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:'Bearer '+key,'OpenAI-Safety-Identifier':createHash('sha256').update('tribunal-ia-presenter-v1').digest('hex')},body:form,signal:AbortSignal.timeout(30000)});
    }
    if(!upstream.ok){
      const payload=await upstream.json().catch(()=>null);
      const e=payload?.error || {};
      const detail=safeDetail(e.message);
      const diagnostic={status:upstream.status,type:safeDetail(e.type),code:safeDetail(e.code),param:safeDetail(e.param),request_id:safeDetail(upstream.headers.get('x-request-id'))};
      console.error('OpenAI error',JSON.stringify({...diagnostic,message:detail}));
      return json(res,upstream.status,{error:'OpenAI: '+(detail||'sem mensagem de erro')+(diagnostic.code?' | código: '+diagnostic.code:'')+(diagnostic.param?' | parâmetro: '+diagnostic.param:''),...diagnostic});
    }
    if(pathname==='/api/consult'){
      const result=await upstream.json();
      const answer=(result.output||[]).flatMap(item=>item.type==='message'?(item.content||[]):[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n');
      if(!answer.trim())return json(res,502,{error:'Backend não forneceu resposta verificável.'});
      const sources=(result.output||[]).flatMap(item=>item.type==='message'?(item.content||[]):[]).flatMap(c=>c.annotations||[]).filter(a=>a.type==='url_citation').map(a=>({title:a.title,url:a.url}));
      return json(res,200,{answer:answer.slice(0,6000),sources:sources.slice(0,10)});
    }
    const sdp=await upstream.text();if(!sdp.startsWith('v=0'))return json(res,502,{error:'Resposta SDP inesperada da API'});
    return json(res,201,{transport:{sdp}});
  }catch(e){console.error('Falha de sessão',e.name);if(!res.headersSent)json(res,502,{error:'Falha ao conectar à OpenAI.'});}
});
server.requestTimeout=75000;server.headersTimeout=15000;
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Tribunal IA: servidor ativo; configuração '+(ready?'presente':'pendente')));
