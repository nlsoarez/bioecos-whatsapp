# Gap analysis greenfield

| Requisito | Estado | Implementação |
|---|---|---|
| Webhook Evolution | Implementado | `POST /webhooks/evolution` |
| EvolutionService isolado | Implementado | envio, normalização, timeout, retry e health |
| Idempotência | Implementado | índice único em `external_message_id` |
| Débora e prompt | Implementado | configuração versionada |
| RAG | Implementado, integração pendente | pgvector + full-text; embeddings exigem chave |
| Tools | Implementado | seis tools com validação |
| Contatos/leads/conversas/mensagens | Implementado | PostgreSQL |
| Tags e pipeline | Implementado | allowlists e seed idempotente |
| Handoff e pausa | Implementado | transação única |
| Histórico e logs | Implementado | mensagens e `audit_logs` |
| Dashboard/visão do contato | Implementado como API | frontend não criado |
| Docker | Implementado | API + PostgreSQL/pgvector |
| Testes mínimos | Implementado | 12 cenários + parser Evolution |
| Evolution real | Pendente | depende de instância e número |
| OpenAI real | Pendente | depende de chave e modelo permitido |
| Preços/calendário/vagas | Pendente com cliente | deliberadamente não fixados |
| LGPD operacional | Parcial | minimização prevista; política formal pendente |
| Consentimento/exclusão/anonimização | Pendente | exige regra de negócio e autorização administrativa |
| Responsáveis/horários do handoff | Pendente | exige dados da Bioecos |
| Painel visual | Não implementado | API preparada; não havia painel a reutilizar |

