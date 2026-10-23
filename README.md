# Ritmo

Aplicativo pessoal de hábitos, metas e tarefas com Supabase Auth e PostgreSQL, além do bot de notificações no repositório separado.

## Site seguro

O site é estático e usa a chave publicável do Supabase em `supabase-config.js`. Essa chave é própria para o navegador; a proteção dos dados depende de Auth e das políticas RLS instaladas no banco. Nunca coloque uma chave `sb_secret_...` ou `service_role` neste repositório.

Para publicar gratuitamente com HTTPS:

1. No GitHub, abra **Settings → Pages**.
2. Em **Build and deployment**, escolha **GitHub Actions**.
3. O workflow em `.github/workflows/deploy-pages.yml` publica o site a cada push na branch `main`.
4. Configure a URL publicada em Supabase **Authentication → URL Configuration**. Use `https://fake-zzz.github.io/painel-fakezxc/` como Site URL e adicione essa URL às Redirect URLs.
5. Crie sua conta na própria tela do Ritmo. Se a confirmação por e-mail estiver ativa, confirme o e-mail para entrar.

A versão servida diretamente pela porta HTTP do Waifly não deve ser usada para login; use o endereço HTTPS do GitHub Pages.

## Modelo de dados

O site grava hábitos, resets, metas, progresso diário, tarefas e check-ins no Supabase. As tabelas usam RLS e cada linha está ligada ao usuário autenticado. O histórico antigo do protótipo em `localStorage` não é importado.
