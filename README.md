# typhoon-blog

신중우의 개발 블로그. Backend, ML, Infrastructure.

- **URL**: https://typhoon.is-a.dev
- **Preview**: https://typhoon-blog.pages.dev
- **GitHub**: https://github.com/typhoon1217/typhoon-blog
- **Stack**: Astro + Fuwari + Tailwind CSS + Cloudflare Pages
- **언어**: 한국어 / English

## 로컬 개발

```sh
pnpm install
pnpm dev        # localhost:4321
pnpm build      # 프로덕션 빌드
```

## 포스트 작성

```
src/content/posts/ko/  # 한국어 포스트
src/content/posts/en/  # 영어 포스트
```

프론트매터:
```yaml
---
title: 포스트 제목
published: YYYY-MM-DD
description: 한 줄 설명
tags:
  - tag1
category: Category
draft: false
---
```

## 배포

`main` 브랜치 푸시 시 GitHub Actions가 자동으로 Cloudflare Pages에 배포합니다.
