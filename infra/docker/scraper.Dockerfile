FROM python:3.12-slim AS runtime

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV MCP_SECRET_LIST_PATH=/app/scraper/secret-list.json

COPY services/scraper/pyproject.toml ./pyproject.toml
COPY services/scraper/scraper ./scraper
COPY packages/types/src/secret-list.json ./scraper/secret-list.json

RUN pip install --no-cache-dir . \
  && python -m playwright install --with-deps chromium

EXPOSE 8000
CMD ["uvicorn", "scraper.service:app", "--host", "0.0.0.0", "--port", "8000"]
