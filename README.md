# 🛠 COS 자동 주문 테스트 & 콘솔 로그 분석 시스템

이 프로젝트는 **더현대닷컴(COS)** 샵인샵 사이트의 콘솔 에러를 **자동 수집 및 분석**하는 Node.js 기반 자동화 도구입니다.  
사이트에서 발생하는 오류를 Puppeteer로 수집하고, Azure OpenAI GPT-4o를 통해 **원인과 대응방안을 자동 분석**합니다.

---

## ✅ 사전 준비 사항

### 1. Node.js 설치
- [Node.js 공식 사이트](https://nodejs.org/)에서 설치 (LTS 권장)
- 설치 확인
```bash
node -v
npm -v
```

---

### 2. 필수 패키지 설치

```bash
npm init -y
npm install puppeteer @azure-rest/ai-inference @azure/core-auth
```

---

## 🚀 실행 방법

```bash
node logger_live.js
```

---

## 📦 생성되는 파일

- `console-log-<timestamp>.json` : 수집된 콘솔 로그 원본
- `analysis-result.json` : GPT-4o 분석 결과 요약

---

## 💡 동작 요약

1. Puppeteer로 더현대닷컴 사이트 접속
2. 콘솔 에러(warning, error)와 request 실패 항목 수집
3. 로그 JSON 파일로 저장
4. Azure OpenAI API 호출 → 로그 요약 및 대응책 수신
5. 결과 파일로 저장

---

## 📚 의존 패키지 목록

- `puppeteer` : 브라우저 자동화
- `@azure-rest/ai-inference` : Azure OpenAI 호출
- `@azure/core-auth` : 인증 처리

---

## 📬 문의
내부 시스템 자동화, 테스트, 로그 분석 개선에 대한 아이디어나 협업이 필요하다면 담당자에게 연락 주세요.
