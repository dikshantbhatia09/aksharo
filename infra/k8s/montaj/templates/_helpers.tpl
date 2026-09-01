{{/*
Shared naming and labelling helpers.

Every object in the chart is named <release>-<component> and carries the
standard app.kubernetes.io labels plus montaj.ai/component, which is what the
Grafana dashboards and the network policies select on.
*/}}

{{- define "montaj.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "montaj.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "montaj.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "montaj.labels" -}}
helm.sh/chart: {{ include "montaj.chart" . }}
{{ include "montaj.commonSelectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
montaj.ai/environment: {{ .Values.environment | quote }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "montaj.commonSelectorLabels" -}}
app.kubernetes.io/name: {{ include "montaj.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Per-component labels. Call with (dict "root" $ "component" $name).
*/}}
{{- define "montaj.componentLabels" -}}
{{- $root := .root -}}
{{ include "montaj.labels" $root }}
app.kubernetes.io/component: {{ .component }}
montaj.ai/component: {{ .component }}
{{- end -}}

{{- define "montaj.componentSelectorLabels" -}}
{{- $root := .root -}}
{{ include "montaj.commonSelectorLabels" $root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "montaj.componentFullname" -}}
{{- printf "%s-%s" (include "montaj.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Image reference. Call with (dict "root" $ "spec" $componentSpec).
The component may pin its own tag; otherwise the chart-wide tag wins, and
failing that the chart appVersion.
*/}}
{{- define "montaj.image" -}}
{{- $root := .root -}}
{{- $spec := .spec -}}
{{- $registry := default $root.Values.image.registry $spec.registry -}}
{{- $tag := default (default $root.Chart.AppVersion $root.Values.image.tag) $spec.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" (trimSuffix "/" $registry) $spec.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" $spec.repository $tag -}}
{{- end -}}
{{- end -}}

{{/* Name of the Kubernetes Secret holding the CONTRACTS section 1 variables. */}}
{{- define "montaj.envSecretName" -}}
{{- .Values.externalSecrets.secretName | default (printf "%s-env" (include "montaj.fullname" .)) -}}
{{- end -}}

{{- define "montaj.configMapName" -}}
{{- printf "%s-config" (include "montaj.fullname" .) -}}
{{- end -}}

{{/*
BullMQ waiting-list key for a queue name, e.g. bull:ai.transcribe:wait.
Call with (dict "root" $ "queue" "ai.transcribe").
*/}}
{{- define "montaj.queueWaitKey" -}}
{{- printf "%s:%s:wait" .root.Values.keda.queuePrefix .queue -}}
{{- end -}}

{{/*
Ingress host for a component's `ingress.host` key ("web" or "api").
*/}}
{{- define "montaj.ingressHost" -}}
{{- $root := .root -}}
{{- index $root.Values.ingress.hosts .key -}}
{{- end -}}
