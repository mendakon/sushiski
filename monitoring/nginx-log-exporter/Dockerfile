FROM python:3.12-alpine
RUN pip install --no-cache-dir prometheus-client==0.21.1
COPY exporter.py /exporter.py
EXPOSE 4040
# needs read on nginx-written logs
USER root
CMD ["python", "-u", "/exporter.py"]
