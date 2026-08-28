# Gap analysis greenfield

| Requisito | Estado | Implementação |
|---|---|---|
| Webhook Evolution | Implementado | `POST /webhooks/evolution` |
| EvolutionService isolado | Implementado | envio, normalização, timeout, retry e health |
| Idempotência | Implementado | índice único em `external_message_id` |
| Débora e prompt | Implementado | configuração versionada |
| RAG | Implementado | pgvector + full-text; embeddings automáticos com chave operacional |
| Tools | Implementado | seis tools com validação |
| Contatos/leads/conversas/mensagens | Implementado | PostgreSQL |
| Tags e pipeline | Implementado | allowlists e seed idempotente |
| Handoff e pausa | Implementado | transação única |
| Histórico e logs | Implementado | mensagens e `audit_logs` |
| Dashboard/visão do contato | Implementado | portal GitHub Pages autenticado, histórico e ações operacionais |
| Docker | Implementado | API sem porta pública + PostgreSQL/pgvector + backup diário |
| Testes automatizados | Implementado | atendimento, parser, autenticação, rotas, RAG e workers |
| Evolution real | Pendente | depende de instância e número |
| OpenAI real | Pendente | depende de chave e modelo permitido |
| Preços/calendário/vagas | Pendente com cliente | deliberadamente não fixados |
| LGPD operacional | Parcial | minimização, retenção, exportação e exclusão implementadas; política jurídica formal pendente |
| Exclusão/exportação | Implementado | confirmação explícita no portal e cascata transacional |
| Responsáveis/horários do handoff | Pendente | exige dados da Bioecos |
| Painel visual | Implementado | monitoramento, chave, leads, histórico, handoff e acompanhamento |
