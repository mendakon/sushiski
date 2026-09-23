FROM python:3.12-slim
RUN pip install --no-cache-dir prometheus_client==0.21.1 "psycopg[binary]==3.2.9"
COPY exporter.py /exporter.py
EXPOSE 9104
USER nobody
CMD ["python", "-u", "/exporter.py"]
