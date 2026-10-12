# Automação WhatsApp Bioecos

Backend greenfield para o atendimento da Bioecos com WhatsApp, Débora, base de conhecimento, qualificação, CRM e handoff humano.

## O que está implementado

- webhook Evolution API v2 em `POST /webhooks/evolution`;
- fila durável para webhooks, com deduplicação, trava distribuída, retry exponencial e fila de falhas;
- envio de texto pela rota Evolution v2 `POST /message/sendText/{instanceName}`;
- modo somente IA: a OpenAI conduz a conversa usando a base institucional e referências técnicas aprovadas; sem IA operacional não há resposta simulada por regras;
- RAG semântico com `pgvector` e recuperação textual complementar em português;
- contatos, leads, conversas, mensagens, tags, pipeline, notas e auditoria;
- qualificação contextual de lead frio, morno e quente, com histórico de mudanças, dúvidas e objeções;
- estados explícitos de IA, espera pelo coordenador, coordenador atendendo, conversa finalizada e matrícula concluída;
- acompanhamento opcional nos dias 30, 60 e 90, exclusivo para leads quentes, com opt-out por `SAIR`, trava contra duplicidade e limite de falhas;
- notificação automática ao coordenador, com resumo e link para o atendimento, além de falha visível e reenvio pelo portal;
- pausa efetiva da IA após handoff ou intervenção humana;
- seed idempotente de projeto, agente, tags, pipeline e conhecimento;
- API administrativa mínima para dashboard, contato, pipeline e pausa;
- painel operacional autenticado para configurar a chave OpenAI, monitorar serviços e gerar o QR Code do WhatsApp;
- embeddings automáticos após cadastrar a chave e na inicialização;
- lista persistente de números ignorados, com CRUD no dashboard e bloqueio antes da fila, IA, lead e follow-up;
- expansão incremental da base da Débora pelo portal, com cursos, conhecimentos, documentos, histórico, detecção de divergências e imagens enviáveis pelo WhatsApp;
- exportação e exclusão de dados de lead, retenção configurável e backups diários;
- cenários de homologação do atendimento, da indisponibilidade da IA e do webhook.

O projeto não usa n8n.

## Arquitetura

```text
WhatsApp
  → Evolution API v2
  → POST /webhooks/evolution
  → fila PostgreSQL
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

O portal técnico fica em `docs/` e é servido exclusivamente pelo backend no VPS Hostinger. O projeto não publica nem depende de GitHub Pages ou GitHub Actions.

## Execução local

Pré-requisitos: Node.js 22+, Docker com Compose e credenciais da Evolution. A chave OpenAI operacional é obrigatória para o atendimento automático.

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

No Windows/PowerShell, copie o arquivo com `Copy-Item .env.example .env`.

O servidor gera automaticamente os vetores pendentes quando a chave inserida no portal está operacional. `db:embed` continua disponível apenas como comando administrativo.

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
| `GET` | `/live` | liveness do processo |
| `GET` | `/ready` | prontidão de banco, webhook, IA, embeddings e fila |
| `POST` | `/webhooks/evolution` | entrada de `MESSAGES_UPSERT` |
| `GET` | `/admin/dashboard` | totais por etapa e conversas recentes |
| `GET` | `/admin/contacts/:contactId` | visão consolidada e histórico |
| `PATCH` | `/admin/conversations/:id/pause` | pausa/reativação manual |
| `PATCH` | `/admin/conversations/:id/pipeline` | movimentação manual do card |
| `PUT` | `/dashboard/settings/monthly-followup` | ativa ou desativa o acompanhamento mensal |
| `PUT` | `/dashboard/settings/coordinator-phone` | armazena cifrado o WhatsApp do coordenador |
| `GET` | `/dashboard/leads?filter=` | lista e filtra leads operacionais |
| `GET` | `/dashboard/leads/:contactId` | histórico completo do lead |
| `GET` | `/dashboard/leads/:contactId/export` | exportação LGPD do lead |
| `DELETE` | `/dashboard/leads/:contactId` | exclusão confirmada dos dados do lead |
| `GET` | `/dashboard/conversations/:id` | abre o atendimento pelo link da notificação |
| `PATCH` | `/dashboard/conversations/:id/workflow` | assume, devolve, conclui ou encerra conversa |
| `POST` | `/dashboard/notifications/:id/retry` | reenvia notificação que falhou |
| `GET/POST/PATCH/DELETE` | `/dashboard/knowledge` | gerencia somente os conhecimentos adicionais |
| `POST` | `/dashboard/knowledge/documents` | valida, extrai e indexa documento adicional |
| `GET/POST/PATCH/DELETE` | `/dashboard/knowledge/media` | gerencia imagens vinculadas aos conhecimentos |
| `POST` | `/dashboard/knowledge/test` | testa a recuperação real e mostra as fontes usadas |

As rotas administrativas exigem o cabeçalho `x-admin-key`.
As rotas de `/dashboard` exigem a sessão autenticada do portal.

## Banco e importação

```bash
npm run db:migrate
npm run db:seed
npm run db:embed
```

O seed usa chaves únicas e hash de conteúdo. Ele mantém cinco fontes ativas em `config/knowledge/`: quatro institucionais e uma coleção técnica externa delimitada. O seed só desativa fontes desse diretório e não toca nos conteúdos adicionados pelo portal. Embeddings só são recalculados para chunks sem vetor.

Os conteúdos gerenciados ficam em `managed_knowledge_entries`, com versões em `managed_knowledge_versions`, e são espelhados nas tabelas RAG existentes (`knowledge_documents` e `knowledge_chunks`). Enquanto a vetorização não termina, o status permanece `processing` e o conteúdo não participa das respostas. Imagens ficam em `knowledge_media`; todos esses registros são isolados pelo projeto Bioecos e as exclusões administrativas são lógicas.

## Testes

```bash
npm test
npm run build
```

Os testes locais não chamam OpenAI nem Evolution. A homologação real ainda exige credenciais, uma instância Evolution v2 conectada e o número definitivo do WhatsApp.

## Hostinger

O arquivo `docker-compose.hostinger.yml` cria um projeto Docker isolado chamado `bioecos`, com rede, volumes e nomes de contêiner exclusivos. A API não publica porta direta; recebe tráfego apenas pelo proxy HTTPS já ligado à rede `bioecos_edge`.

O Gerenciador Docker da Hostinger não executa o `build` remoto do Compose. A imagem deve ser construída manualmente no próprio VPS a partir de um pacote de código revisado e transferido por canal seguro. O portal é servido pelo próprio backend em `/bioecos/portal/`; o projeto não depende do GitHub Pages. O contêiner de produção não contém Git, não baixa branches, não instala dependências na inicialização e executa como usuário sem privilégios.

```bash
mkdir -p /docker/bioecos/releases/REVISAO
tar -xzf /tmp/bioecos-REVISAO.tgz -C /docker/bioecos/releases/REVISAO
cd /docker/bioecos/releases/REVISAO
docker build --pull=false --build-arg BUILD_REVISION=REVISAO -t bioecos-whatsapp:0.3.3-social-preview-secure .
```

As imagens-base são fixadas por digest. O Compose usa `pull_policy: never`, filesystem somente leitura, remoção de capabilities, limite de processos, rede interna e `no-new-privileges`. A única tarefa root é o inicializador sem rede que ajusta a propriedade dos dois volumes graváveis.

As variáveis `BIOECOS_*` devem ser cadastradas somente no ambiente da Hostinger. Não substitua os placeholders por segredos dentro do arquivo versionado. `BIOECOS_BACKUP_ENCRYPTION_KEY` deve ser uma chave aleatória exclusiva com pelo menos 32 caracteres e deve ser guardada fora do VPS; sem ela os backups cifrados não podem ser restaurados. A chave OpenAI e o número do coordenador são inseridos pelo responsável dentro do dashboard e ficam cifrados no volume `bioecos_config_data`; não precisam ser gravados no Compose. Sem chave ou crédito, o atendimento automático informa indisponibilidade temporária; não existe modo híbrido.

Os dados pessoais persistentes são cifrados com AES-256-GCM. O telefone possui um índice HMAC separado para preservar identificação e deduplicação sem armazenar o número em texto puro. A migração de registros antigos é idempotente e ocorre antes de a API aceitar tráfego. Sessões do dashboard podem ser revogadas no servidor e expiram em 60 minutos.

O acompanhamento 30/60/90 nasce desativado. A ativação é feita conscientemente no portal; cada sequência só começa para um lead quente elegível.

## Limites deliberados

- Preços, turmas, vagas, descontos, responsáveis e horários humanos permanecem dados operacionais pendentes.
- A restauração completa precisa ser ensaiada periodicamente em um banco separado. O contêiner valida o catálogo antes de cifrar; `verify-bioecos-backup` verifica checksum, descriptografia e catálogo posteriormente.
