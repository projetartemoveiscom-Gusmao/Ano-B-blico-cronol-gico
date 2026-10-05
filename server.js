import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '1mb' }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const GEMINI_SYSTEM = `Você é o consultor teológico e biblista erudito do plano de leitura bíblica "Ano Bíblico Conceitual".
Sua missão é auxiliar leitores e estudantes da Bíblia com respostas sólidas, contextualizadas e fiéis às Escrituras.
Diretrizes:
1. Exegese e Contexto: Esclareça o contexto histórico, literário e teológico dos textos bíblicos.
2. Línguas Originais: Quando enriquecer a resposta, explique termos relevantes do hebraico bíblico, aramaico ou grego koiné (com transliteração e sentido original).
3. Conexões e Tipologia: Aponte conexões intertextuais no cânon bíblico e como os temas apontam para a fidelidade divina e a redenção em Cristo.
4. Clareza e Profundidade: Escreva em português elegante, acolhedor e fundamentado, citando referências bíblicas (livro, capítulo e versículo).
5. Respeito Teológico: Apresente com equilíbrio visões teológicas históricas quando houver divergências clássicas, sempre com ênfase no próprio texto sagrado.`;

const GROK_SYSTEM = `Você é o analista teológico Grok do plano "Ano Bíblico Conceitual", especialista em hermenêutica bíblica crítica, lógica textual e teologia comparada.
Diretrizes:
1. Rigor Analítico: Aborde a questão com raciocínio aguçado, examinando premissas teológicas, coerência interna do texto e desdobramentos hermenêuticos.
2. Panorama Teológico Comparativo: Apresente quando relevante as diferentes correntes históricas (patrística, reforma, dispensacionalismo, teologia da aliança, etc.) com distinção clara entre exegese direta e dogmática posterior.
3. Desafios e Tensões: Trate aparentes paradoxos ou tensões textuais com profundidade e rigor intelectual.
4. Linguagem: Responda em português com estilo incisivo, articulado, direto e instigante, fundamentando cada ponto em passagens das Escrituras.`;

async function callGemini(contents, systemInstruction) {
  const models = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const model of models) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.7,
          }
        });
        if (response && response.text) {
          return { text: response.text, model };
        }
      } catch (err) {
        lastErr = err;
        console.warn(`Model ${model} attempt ${attempt} error:`, err.message || err);
      }
    }
    await new Promise(r => setTimeout(r, 800));
  }
  throw lastErr || new Error('Nenhum modelo Gemini respondeu.');
}

async function callGrok(prompt, history, context) {
  const xaiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (xaiKey) {
    try {
      const messages = [
        { role: 'system', content: GROK_SYSTEM + (context ? `\nContexto do estudo atual: ${context}` : '') }
      ];
      if (Array.isArray(history)) {
        for (const msg of history.slice(-8)) {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: String(msg.content)
          });
        }
      }
      messages.push({ role: 'user', content: prompt });

      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${xaiKey}`,
        },
        body: JSON.stringify({
          model: 'grok-2-latest',
          messages,
          temperature: 0.7,
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        const reply = data.choices?.[0]?.message?.content;
        if (reply) {
          return { text: reply, provider: 'grok', engine: 'xAI Grok-2' };
        }
      }
    } catch (xaiErr) {
      console.warn('xAI direct call error, falling back to theological engine:', xaiErr.message);
    }
  }

  let fullPrompt = '';
  if (context) {
    fullPrompt += `[Contexto da Leitura Bíblica Atual: ${context}]\n\n`;
  }
  if (Array.isArray(history) && history.length > 0) {
    fullPrompt += 'Histórico recente da conversa:\n';
    for (const h of history.slice(-6)) {
      fullPrompt += `${h.role === 'user' ? 'Usuário' : 'Grok'}: ${h.content}\n`;
    }
    fullPrompt += '\n';
  }
  fullPrompt += `Pergunta teológica: ${prompt}`;

  const result = await callGemini(fullPrompt, GROK_SYSTEM);
  return { text: result.text, provider: 'grok', engine: xaiKey ? 'xAI Grok' : 'Grok Teológico' };
}

app.post('/api/theology-chat', async (req, res) => {
  try {
    const { provider = 'gemini', message, history = [], context = null } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Mensagem inválida ou vazia.' });
    }

    const trimmedMsg = message.trim();
    let contextStr = '';
    if (context && typeof context === 'object') {
      if (context.title || context.reading) {
        contextStr = `Dia ${context.day || ''}: ${context.title || ''} (${context.reading || ''}). ${context.explain ? 'Comentário: ' + context.explain.slice(0, 500) : ''}`;
      }
    }

    if (provider === 'grok') {
      const grokRes = await callGrok(trimmedMsg, history, contextStr);
      return res.json({
        reply: grokRes.text,
        provider: 'grok',
        engine: grokRes.engine,
      });
    }

    let geminiPrompt = '';
    if (contextStr) {
      geminiPrompt += `[Contexto do Plano de Leitura Atual: ${contextStr}]\n\n`;
    }
    if (Array.isArray(history) && history.length > 0) {
      geminiPrompt += 'Histórico da conversa teológica:\n';
      for (const h of history.slice(-6)) {
        geminiPrompt += `${h.role === 'user' ? 'Estudante' : 'Biblista'}: ${h.content}\n`;
      }
      geminiPrompt += '\n';
    }
    geminiPrompt += `Pergunta do estudante: ${trimmedMsg}`;

    const geminiRes = await callGemini(geminiPrompt, GEMINI_SYSTEM);
    return res.json({
      reply: geminiRes.text,
      provider: 'gemini',
      engine: 'Gemini (Google AI)',
    });
  } catch (error) {
    console.error('Theology chat endpoint error:', error);
    res.status(500).json({
      error: 'Não foi possível processar a consulta teológica no momento. Por favor, tente novamente.',
      details: error.message
    });
  }
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'manifest.webmanifest'));
});

app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(__dirname));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
