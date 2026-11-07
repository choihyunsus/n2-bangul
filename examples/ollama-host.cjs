// Supply a locally installed model through environment configuration owned by the operator.
const { ollamaChat } = require('n2-bangul');
const model = process.env.N2_MODEL;
if (!model) throw new Error('Set N2_MODEL to a model installed in your Ollama service');
module.exports = {
  provider: ollamaChat({
    id: 'local',
    model,
    endpoint: process.env.N2_OLLAMA_URL ?? 'http://127.0.0.1:11434/api/chat',
    contextLength: 2048,
    think: false,
  }),
};
