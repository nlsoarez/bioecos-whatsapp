# Arquitetura técnica

## Decisões

O sistema é um monólito modular. Separar em vários serviços agora criaria custo operacional sem resolver um problema comprovado. Os limites internos permitem extração futura sem acoplamento:

- `http`: validação e exposição de rotas;
- `services/evolution`: tradução do contrato Evolution v2;
- `services/conversation`: orquestração IA-first e políticas incontornáveis;
- `services/lead-assessment`: classificação contextual, interesse, dúvidas e objeções;
- `services/coordinator-notification`: alerta, registro de falha e reenvio ao coordenador;
- `services/monthly-followup`: régua limitada nos dias 15, 30 e 45;
- `services/openai`: Responses API e ciclo de tools;
- `services/tool`: validação de argumentos e autorização de ações;
- `repositories`: persistência e transações;
- `db`: schema, migrações, seed e embeddings.

## Fluxo de mensagem

1. O webhook valida o segredo opcional e normaliza o evento.
2. Eventos que não sejam mensagens recebidas, mensagens próprias, grupos e conteúdo sem texto são ignorados.
3. A mensagem é inserida com `UNIQUE external_message_id`.
4. Duplicidades encerram o processamento sem gerar nova resposta.
5. Um pedido `SAIR` cancela o acompanhamento mesmo se a conversa estiver pausada.
6. Se a conversa pertence ao coordenador ou está pausada, a IA não é chamada.
7. O contexto recente classifica o lead e registra curso, dúvidas e objeções.
8. Pagamento, negociação financeira, orçamento/proposta ou pedido humano/coordenador geram handoff com resumo e alerta. Perguntas, interesse e inscrição permanecem com a IA.
9. Nos demais casos, a Responses API conduz a conversa com os chunks dos dois documentos oficiais.
10. Se a IA estiver indisponível, o contato recebe uma resposta temporária segura sem acionar indevidamente a coordenação.
11. Tools são validadas por schema; a IA não pode marcar matrícula, resultado ou assumir estados humanos.
12. A resposta é enviada pela Evolution e persistida.

## Acompanhamento 15/30/45

O worker consulta no máximo 25 candidatos a cada cinco minutos. Uma sequência elegível agenda contatos após 15, 30 e 45 dias, com textos distintos e sem urgência artificial. Resposta, conversão, desinteresse, encerramento, handoff, coordenador assumindo, três tentativas ou opt-out retiram o contato da fila. O recurso global fica desativado por padrão e é controlado pelo portal autenticado.

## RAG

Cada seção dos dois documentos oficiais vira um chunk. Fontes antigas são preservadas, mas ficam inativas. O vetor padrão tem 1.536 dimensões, compatível com `text-embedding-3-small`. A busca usa o maior score entre similaridade cosseno e full-text em português.

O histórico completo fica no PostgreSQL. O modelo recebe dados estruturados, estado, classificação, dúvidas, objeções, até 24 mensagens recentes e até seis chunks recuperados.

## Controles de segurança

- allowlist de tags;
- allowlist de etapas;
- estados de coordenador e resultados não podem ser definidos pela IA;
- handoff transacional: etapa, tag, resumo e pausa são atualizados juntos;
- CPF não aparece como pergunta automática no prompt inicial;
- CPF é cifrado em repouso e a API administrativa expõe apenas `has_cpf`;
- logs de auditoria para mensagens, tags, pipeline, dados, notas e handoffs;
- segredos somente por ambiente;
- portal protegido por sessão assinada; chaves e telefone do coordenador são cifrados no servidor e nunca retornam ao navegador.

## Contratos externos

O adaptador mira Evolution API v2. O envio utiliza `POST /message/sendText/{instanceName}`, cabeçalho `apikey` e corpo `{ number, text }`, compatível com a versão implantada. A entrada reconhece `MESSAGES_UPSERT` e variações de caixa/pontuação observadas no contrato v2.

A IA utiliza `POST /responses` com custom function tools. Embeddings utilizam `POST /embeddings`. Modelo conversacional e modelo de embedding são variáveis de ambiente.
