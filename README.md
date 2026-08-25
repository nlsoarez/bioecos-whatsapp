# Automação WhatsApp Bioecos

Backend greenfield para o atendimento da Bioecos com WhatsApp, Débora, base de conhecimento, qualificação, CRM e handoff humano.

## O que está implementado

- webhook Evolution API v2 em `POST /webhooks/evolution`;
- bloqueio de eventos irrelevantes, mensagens próprias, grupos e mensagens duplicadas;
- envio de texto pela rota Evolution v2 `POST /message/sendText/{instanceName}`;
- agente Débora pela OpenAI Responses API com tools validadas;
- RAG híbrido: busca semântica com `pgvector` e fallback full-text em português;
- contatos, leads, conversas, mensagens, tags, pipeline, notas e auditoria;
- pausa efetiva da IA após handoff ou intervenção humana;
- seed idempotente de projeto, agente, tags, pipeline e conhecimento;
- API administrativa mínima para dashboard, contato, pipeline e pausa;
- 12 cenários de homologação exigidos, além de testes do webhook.

O projeto não usa n8n.

## Arquitetura

```text
WhatsApp
  → Evolution API v2
  → POST /webhooks/evolution
  → ConversationService
      → políticas determinísticas de segurança
      → Débora / OpenAI Responses API
      → tools validadas
      → RAG PostgreSQL + pgvector
      → CRM e auditoria
  → Evolution API v2
  → WhatsApp
```

Detalhes em [docs/architecture.md](docs/architecture.md).

## Execução local

Pré-requisitos: Node.js 22+, Docker com Compose e credenciais próprias de OpenAI/Evolution.

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run db:embed
npm run dev
```

No Windows/PowerShell, copie o arquivo com `Copy-Item .env.example .env`.

`db:embed` exige `OPENAI_API_KEY`. Sem embeddings, a aplicação continua com busca textual, mas isso não deve ser considerado homologação completa do RAG semântico.

## Configuração obrigatória

Não coloque segredos no código ou no Git. Configure no `.env` ou em um gerenciador de segredos:

- `DATABASE_URL`;
- `OPENAI_API_KEY`, `AI_PROVIDER`, `AI_MODEL` e `AI_EMBEDDING_MODEL`;
- `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_INSTANCE_NAME`;
- `ADMIN_API_KEY`;
- `PII_ENCRYPTION_KEY`, usada para cifrar CPF com AES-256-GCM;
- opcionalmente `EVOLUTION_WEBHOOK_SECRET`, caso a borda/proxy e o emissor suportem o mesmo cabeçalho estático.

O site oficial é configurado por `BIOECOS_SITE_URL` e deve permanecer como `https://www.bioecoscursos.com.br/`.

## Rotas

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/health` | backend, banco, Evolution e configuração de IA |
| `POST` | `/webhooks/evolution` | entrada de `MESSAGES_UPSERT` |
| `GET` | `/admin/dashboard` | totais por etapa e conversas recentes |
| `GET` | `/admin/contacts/:contactId` | visão consolidada e histórico |
| `PATCH` | `/admin/conversations/:id/pause` | pausa/reativação manual |
| `PATCH` | `/admin/conversations/:id/pipeline` | movimentação manual do card |

As rotas administrativas exigem o cabeçalho `x-admin-key`.

## Banco e importação

```bash
npm run db:migrate
npm run db:seed
npm run db:embed
```

O seed usa chaves únicas e hash de conteúdo. Executá-lo novamente atualiza configurações sem duplicar projeto, agente, tags, etapas ou documentos. Embeddings só são recalculados para chunks sem vetor.

## Testes

```bash
npm test
npm run build
```

Os testes locais não chamam OpenAI nem Evolution. A homologação real ainda exige credenciais, uma instância Evolution v2 conectada e o número definitivo do WhatsApp.

## Limites deliberados

- Não há painel web visual; existe uma API administrativa segura para ser consumida por um painel futuro.
- Não há fila distribuída. O webhook é processado de forma síncrona; para alto volume, introduza uma fila durável antes de produção.
- A Evolution API não foi instalada neste computador. O adaptador segue o contrato v2 documentado, mas precisa ser verificado contra a versão efetivamente implantada.
- Preços, turmas, vagas, descontos, responsáveis e horários humanos permanecem dados operacionais pendentes.
