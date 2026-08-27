# Automação WhatsApp Bioecos

Backend greenfield para o atendimento da Bioecos com WhatsApp, Débora, base de conhecimento, qualificação, CRM e handoff humano.

## O que está implementado

- webhook Evolution API v2 em `POST /webhooks/evolution`;
- bloqueio de eventos irrelevantes, mensagens próprias, grupos e mensagens duplicadas;
- envio de texto pela rota Evolution v2 `POST /message/sendText/{instanceName}`;
- modo IA-first: a OpenAI conduz a conversa usando exclusivamente os dois documentos oficiais ativos;
- RAG híbrido: busca semântica com `pgvector` e fallback full-text em português;
- contatos, leads, conversas, mensagens, tags, pipeline, notas e auditoria;
- qualificação contextual de lead frio, morno e quente, com histórico de mudanças, dúvidas e objeções;
- estados explícitos de IA, espera pelo coordenador, coordenador atendendo, conversa finalizada e matrícula concluída;
- acompanhamento opcional nos dias 15, 30 e 45, com mensagens distintas, opt-out por `SAIR` e cancelamento após resposta, conversão, desinteresse ou atendimento humano;
- notificação automática ao coordenador, com resumo e link para o atendimento, além de falha visível e reenvio pelo portal;
- pausa efetiva da IA após handoff ou intervenção humana;
- seed idempotente de projeto, agente, tags, pipeline e conhecimento;
- API administrativa mínima para dashboard, contato, pipeline e pausa;
- painel operacional autenticado para configurar a chave OpenAI, monitorar serviços e gerar o QR Code do WhatsApp;
- cenários de homologação do atendimento, do fallback e do webhook.

O projeto não usa n8n.

## Arquitetura

```text
WhatsApp
  → Evolution API v2
  → POST /webhooks/evolution
  → ConversationService
      → classificação contextual e regras de segurança
      → Débora / OpenAI Responses API (atendimento principal)
      → tools validadas
      → RAG PostgreSQL + pgvector
      → CRM e auditoria
  → Evolution API v2
  → WhatsApp
```

Detalhes em [docs/architecture.md](docs/architecture.md).

O portal técnico estático fica em `docs/` e é publicado pelo GitHub Pages diretamente da branch `main`, sem arquivo de workflow ou Action personalizada.

## Execução local

Pré-requisitos: Node.js 22+, Docker com Compose e credenciais da Evolution. A chave OpenAI operacional é necessária para o atendimento automático; sem ela, a conversa é transferida com segurança.

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
- `OPENAI_API_KEY`, inserida no portal e armazenada cifrada; `AI_PROVIDER`, `AI_MODEL` e `AI_EMBEDDING_MODEL` definem o cliente;
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
| `PUT` | `/dashboard/settings/monthly-followup` | ativa ou desativa o acompanhamento mensal |
| `PUT` | `/dashboard/settings/coordinator-phone` | armazena cifrado o WhatsApp do coordenador |
| `GET` | `/dashboard/leads?filter=` | lista e filtra leads operacionais |
| `GET` | `/dashboard/leads/:contactId` | histórico completo do lead |
| `PATCH` | `/dashboard/conversations/:id/workflow` | assume, devolve, conclui ou encerra conversa |
| `POST` | `/dashboard/notifications/:id/retry` | reenvia notificação que falhou |

As rotas administrativas exigem o cabeçalho `x-admin-key`.
As rotas de `/dashboard` exigem a sessão autenticada do portal.

## Banco e importação

```bash
npm run db:migrate
npm run db:seed
npm run db:embed
```

O seed usa chaves únicas e hash de conteúdo. Ele mantém o histórico, desativa fontes antigas e deixa ativos somente os dois documentos oficiais em `config/knowledge/`. Embeddings só são recalculados para chunks sem vetor.

## Testes

```bash
npm test
npm run build
```

Os testes locais não chamam OpenAI nem Evolution. A homologação real ainda exige credenciais, uma instância Evolution v2 conectada e o número definitivo do WhatsApp.

## Hostinger

O arquivo `docker-compose.hostinger.yml` cria um projeto Docker isolado chamado `bioecos`, com rede, volume e nomes de contêiner exclusivos. A API usa a porta externa `3100`; as portas `80`, `443` e `8080` dos serviços já instalados não são alteradas.

O Gerenciador Docker da Hostinger não executa o `build` remoto do Compose. Por isso, a implantação usa a imagem oficial `node:22-alpine` e faz clone, instalação e build dentro do próprio contêiner isolado, sem GitHub Actions.

As variáveis `BIOECOS_*` devem ser cadastradas somente no ambiente da Hostinger. Não substitua os placeholders por segredos dentro do arquivo versionado. A chave OpenAI e o número do coordenador são inseridos pelo responsável dentro do dashboard e ficam cifrados no volume `bioecos_config_data`; não precisam ser gravados no Compose. Sem chave ou saldo, a IA não improvisa: a conversa é encaminhada para a coordenação.

O acompanhamento 15/30/45 nasce desativado. A ativação é feita conscientemente no portal; cada sequência só começa depois de um novo interesse elegível registrado pela automação.

## Limites deliberados

- Não há fila distribuída. O webhook é processado de forma síncrona; para alto volume, introduza uma fila durável antes de produção.
- Preços, turmas, vagas, descontos, responsáveis e horários humanos permanecem dados operacionais pendentes.
