FROM python:3.12-alpine
RUN pip install --no-cache-dir redis==5.2.1
COPY exporter.py /exporter.py
EXPOSE 9101
# Need to read Misskey worker /proc (uid 991); root in this tiny exporter is fine
USER root
CMD ["python", "-u", "/exporter.py"]
