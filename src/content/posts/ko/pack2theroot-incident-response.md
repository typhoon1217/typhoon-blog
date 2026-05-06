---
title: Pack2theRoot 대응기 — autoremove 한 번에 자동 패치 데몬이 사라진 사건
published: 2026-04-27
description: 운영 중인 Proxmox dev 환경에서 CVE-2026-41651에 취약한 LXC 컨테이너 3개를 발견하고 제거하던 중, autoremove cascade가 unattended-upgrades까지 끌어내린 기록.
tags:
  - infra
  - linux
  - proxmox
  - security
  - korean
category: Infra
draft: false
---

Proxmox dev 환경에 깔린 LXC 컨테이너 6개 중 3개가 며칠 전 공개된 CVE에 취약했다. 흥미로운 건 6개 모두 Ubuntu 24.04인데 *정확히 .3 포인트 릴리스* 컨테이너에만 영향이 있었다는 점이었다.

## Pack2theRoot — 12년 묵은 PackageKit 권한 우회

4월 22일에 공개된 CVE-2026-41651, 별칭 Pack2theRoot. CVSS 8.8 HIGH. 비특권 로컬 사용자가 polkit 인증을 우회해서 RPM 설치/제거는 물론 RPM scriptlet을 root 권한으로 실행할 수 있다. 한마디로 PackageKit이 깔려 있으면 끝이다.

영향 버전은 1.0.2(2014-11)부터 1.3.4까지. 12년 동안 방치된 코드 경로다. 수정은 1.3.5에서.

배포판 패치 상황은 들쑥날쑥했다. Debian은 이미 DSA-6226-1로 Bookworm/Trixie를 보호했고, DLA-4545-1로 Bullseye까지 커버했다. Ubuntu는 모든 릴리스가 "Needs evaluation" 상태였고, Red Hat 쪽도 RHSA 대기 중이었다.

## 24.04.3 LXC만 PackageKit이 있는 이유 — APT Recommends + 템플릿

호스트는 Proxmox VE 9.1.1에 Debian 13 Trixie. PackageKit은 처음부터 설치 안 되어 있다. 안전.

LXC 6개 점검 결과는 패턴이 명확했다.

| 컨테이너 | OS | PackageKit |
|---|---|---|
| A | Ubuntu 24.04 | 미설치 |
| B | Ubuntu 24.04 | 미설치 |
| C | Ubuntu 24.04.3 | **1.2.8-2ubuntu1.5 (취약)** |
| D | Ubuntu 24.04.3 | **1.2.8-2ubuntu1.5 (취약)** |
| E | Ubuntu 24.04.3 | **1.2.8-2ubuntu1.5 (취약)** |
| F | Ubuntu 24.04 | 미설치 |

24.04.3 포인트 릴리스 컨테이너에만 PackageKit이 있었다.

원인을 따라가 보니 `software-properties-common`의 Recommends에 `packagekit`이 들어 있었다. APT의 기본 설정(`Install-Recommends "true"`)이 자동으로 끌어오는 거다. Proxmox LXC 템플릿이 24.04.3 시점에 software-properties-common을 포함하도록 바뀌면서 생긴 부작용. 초기 24.04 컨테이너들은 software-properties-common 없이 만들어졌었다.

## autoremove cascade가 unattended-upgrades까지 끌어내렸다

3개 컨테이너 모두 PackageKit 서비스는 static + inactive였다. 자동 시작도 안 되고 지금 구동 중도 아니었다. D-Bus 활성화 흔적을 보니 4월 26-27일경 5분짜리 lifetime이 몇 번 있었는데, unattended-upgrades나 update-notifier가 daily check를 하면서 깬 흔적이었다.

사전 시뮬레이션을 했다. `apt-get -s remove`로 이 3개 패키지가 뭘 끌어내리는지 확인.

```bash
apt-get -s remove packagekit packagekit-tools software-properties-common
```

정확히 3개가 나왔다. 의존성도 깔끔했고, `add-apt-repository` 사용 흔적도 없었다 (cron, ansible, cloud-init, /opt, /usr/local, bash_history 모두 0건). 기존 PPA 파일들은 `add-apt-repository` 없이도 작동한다. 안전하다고 판단해 실행:

```bash
apt-get remove --purge packagekit packagekit-tools software-properties-common && apt-get autoremove --purge
```

여기서 일이 커졌다.

autoremove cascade가 시뮬레이션 예상과 다르게 11개를 끌어냈다.

```
appstream
gir1.2-packagekitglib-1.0
libappstream5
libdw1t64
libglib2.0-bin
libgstreamer1.0-0
libpackagekit-glib2-18
libstemmer0d
libxmlb2
python3-software-properties
unattended-upgrades
```

**unattended-upgrades가 같이 사라졌다.** 자동 보안 패치 데몬이 날아갔다는 뜻이다.

원인은 시뮬레이션 단계의 누락이었다. `apt-get -s remove`는 직접 제거되는 패키지만 보여준다. autoremove가 뭘 정리할지는 *별도 시뮬레이션*이 필요했는데 그걸 빠뜨렸다. software-properties-common과 다른 도구들이 unattended-upgrades를 Recommends로 가지고 있었고, 이들이 사라지자 autoremove가 unattended-upgrades를 orphan으로 보고 같이 제거했다.

자동 업데이트 손실 윈도우는 약 2-3분이었다.

## 복구 — `--no-install-recommends`로 다시 깔고 보호 표시

cascade 피해를 좁힌 뒤 unattended-upgrades를 다시 설치했다. 이번에는 APT Recommends 함정에 다시 빠지지 않도록 `--no-install-recommends`를 붙였다.

```bash
apt-get install -y --no-install-recommends unattended-upgrades
```

packagekit이 다시 끌려오지 않았다.

다음으로 `apt-mark manual`로 보호 표시. 향후 autoremove에서 보호받기 위함이다.

```bash
apt-mark manual unattended-upgrades
```

`/etc/apt/apt.conf.d/20auto-upgrades`를 재생성해서 자동 업데이트 다시 활성화:

```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

systemd 타이머도 다시 켰다.

```bash
systemctl enable apt-daily.timer apt-daily-upgrade.timer
systemctl enable unattended-upgrades.service
```

## 교훈 — Recommends를 끄고, autoremove는 따로 시뮬레이션

이 사건이 가르친 것 두 가지.

**APT Recommends 기본값이 서버에 GUI 데몬을 줄줄이 끌어들인다.** 처음부터 `/etc/apt/apt.conf.d/99-no-recommends`로 막거나, 설치할 때마다 `--no-install-recommends`를 붙이는 게 맞다. PackageKit이 software-properties-common의 Recommends로 들어왔다는 사실 자체가 이 정책의 부작용이다.

**autoremove는 두 단계로 검증해야 한다.** `apt-get -s remove`와 `apt-get -s autoremove`를 모두 봐야 한다. 두 시뮬레이션이 보여주는 것이 다르다. 중요한 패키지(unattended-upgrades 같은)는 `apt-mark manual`로 미리 보호하면 cascade에서 살아남는다.

마지막으로 한 가지 더. *static + inactive* 서비스도 D-Bus activation으로 깨워질 수 있다. 진짜 면역은 패키지 부재다. PackageKit을 처음부터 설치하지 않으면 미래의 PackageKit CVE가 나와도 영향을 받지 않는다. 공격 표면 최소화는 결국 *없는 코드는 깨지지 않는다*는 단순한 원칙이다.
