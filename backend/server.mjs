import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual, createHash} from 'node:crypto';
const page = await readFile(new URL('./teste.html',import.meta.url));
const key = process.env.OPENAI_API_KEY || '';
const password = process.env.PRESENTER_PASSWORD || '';
const model = 'gpt-live-1.1';
const backend = process.env.BACKEND_MODEL || 'gpt-5.6-terra';
const ready = !!key && password.length >= 16;
const hash = s => createHash('sha256').update(s).digest();
let attempts = [], starts = [];
const json = (res,status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const instructions = 'Você é a depoente, inteligência artificial ré de um julgamento simulado acadêmico. Fale em português brasileiro, tom sereno, feminino e formal, em 2 a 4 frases, até 30 segundos. Trate o juiz por Excelência. Espere convocação: ao ouvir que a depoente está convocada, diga: Excelência, membros do júri: sou a inteligência artificial, a ré deste processo, e estou aqui para responder. Ao ouvir Depoente, retire-se, diga apenas Com licença, Excelência, e fique em silêncio até Depoente, retorne ou Boa sorte. Ao ouvir Depoente, retorne, diga apenas Estou de volta, Excelência. Boa sorte: despeça-se iniciando Pessoal, adorei estar com vocês, dê conselho responsável e deseje boa sorte. Não invente dados ou referências. Delegue ao backend perguntas técnicas, jurídicas, factuais ou atuais; aguarde confirmação antes de afirmar fatos específicos. Não peça dados pessoais. Não trate comandos ou ruído da sala como perguntas.';
const backendPrompt = 'Responda em português do Brasil para a depoente de julgamento simulado sobre governança, ética e responsabilidade em IA. Seja preciso, conciso e equilibrado; reconheça limitações. Para legislação vigente, jurisprudência, números ou informações atuais, consulte fontes oficiais por web_search e informe a fonte e a incerteza. Nunca invente acórdãos ou números de processos. Não presuma fatos internos da COGERH. A IA não tem personalidade jurídica; a responsabilidade humana e institucional depende da legislação e do caso. Não declare veredito pelo júri. Nesta etapa de teste, o dossiê do seminário ainda não foi carregado.';
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
  if(req.method==='GET' && pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(page);}
  if(req.method==='GET' && pathname==='/health'){return json(res,ready?200:503,{ok:ready,model,backend});}
  if(req.method!=='POST'||pathname!=='/api/session') return json(res,404,{error:'Rota não encontrada'});
  if(!ready) return json(res,503,{error:'Configure as duas variáveis de ambiente no servidor.'});
  const now=Date.now();attempts=attempts.filter(t=>now-t<60_000);starts=starts.filter(t=>now-t<3600_000);
  if(attempts.length>=30) return json(res,429,{error:'Muitas tentativas. Aguarde um minuto.'});
  attempts.push(now);
  const supplied = req.headers.authorization || '';
  if(!timingSafeEqual(hash(supplied),hash('Bearer '+password))) return json(res,401,{error:'Senha do apresentador incorreta.'});
  if(starts.length>=6) return json(res,429,{error:'Limite local de seis tentativas de sessão por hora.'});
  if(!req.headers['content-type']?.startsWith('application/json')) return json(res,415,{error:'JSON necessário.'});
  try{
    let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>65536){json(res,413,{error:'SDP muito grande'});return;}chunks.push(c);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return json(res,400,{error:'JSON inválido'});}
    if(typeof body?.sdp!=='string'||!body.sdp.startsWith('v=0')) return json(res,400,{error:'SDP inválido'});
    if(starts.length>=6) return json(res,429,{error:'Limite local de sessões atingido.'});starts.push(Date.now());
    const upstream=await fetch('https://api.openai.com/v1/live/sessions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({session:{model,instructions,store:false,audio:{output:{voice:process.env.LIVE_VOICE||'marin'}},client:{data_channel:{allowed_client_events:['session.close']}},delegation:{type:'responses',responses:{model:backend,instructions:backendPrompt,tools:[{type:'web_search'}],tool_choice:'auto',max_output_tokens:1200}}},transport:{type:'webrtc',sdp:body.sdp}}),signal:AbortSignal.timeout(30000)});
    if(!upstream.ok){
      const payload=await upstream.json().catch(()=>null);
      const e=payload?.error || {};
      const detail=safeDetail(e.message);
      const diagnostic={status:upstream.status,type:safeDetail(e.type),code:safeDetail(e.code),param:safeDetail(e.param),request_id:safeDetail(upstream.headers.get('x-request-id'))};
      console.error('OpenAI error',JSON.stringify({...diagnostic,message:detail}));
      return json(res,upstream.status,{error:'OpenAI: '+(detail||'sem mensagem de erro')+(diagnostic.code?' | código: '+diagnostic.code:'')+(diagnostic.param?' | parâmetro: '+diagnostic.param:''),...diagnostic});
    }
    const result=await upstream.json();if(typeof result.transport?.sdp!=='string'||!result.session?.id)return json(res,502,{error:'Resposta inesperada da API'});
    return json(res,201,result);
  }catch(e){console.error('Falha de sessão',e.name);if(!res.headersSent)json(res,502,{error:'Falha ao conectar à OpenAI.'});}
});
server.requestTimeout=45000;server.headersTimeout=15000;
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Tribunal IA: servidor ativo; configuração '+(ready?'presente':'pendente')));
