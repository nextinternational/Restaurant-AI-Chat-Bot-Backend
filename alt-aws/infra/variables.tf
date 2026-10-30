variable "region" {
  type    = string
  default = "us-east-1"
}
variable "env" {
  type    = string
  default = "prod"
}
variable "domain_name" {
  type        = string
  description = "Public API hostname, e.g. api.yourdomain.com"
}
variable "image_tag" {
  type        = string
  description = "Image tag for the FIRST task definition (push an image to ECR first). Later releases are done by the deploy workflow."
}
variable "mongodb_db_name" {
  type    = string
  default = "restaurant_ai"
}
variable "openai_model" {
  type    = string
  default = "gpt-4o-mini"
}
variable "cors_allowed_origins" {
  type        = string
  default     = ""
  description = "Staff/admin browser origins only (comma separated). Widget origins are per widget key, not here."
}
variable "alarm_email" {
  type        = string
  description = "Receives CloudWatch alarm notifications (confirm the SNS subscription email)"
}
variable "cpu" {
  type    = number
  default = 512
}
variable "memory" {
  type    = number
  default = 1024
}
