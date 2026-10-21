output "ecr_repository_url" { value = aws_ecr_repository.api.repository_url }
output "alb_dns_name" {
  value       = aws_lb.api.dns_name
  description = "Create a CNAME: var.domain_name -> this value"
}
output "nat_static_ip" {
  value       = aws_eip.nat.public_ip
  description = "Allow-list this single IP in MongoDB Atlas Network Access"
}
output "acm_validation_records" {
  description = "Create these CNAME records at your DNS host so the TLS certificate validates"
  value = [for o in aws_acm_certificate.api.domain_validation_options : {
    name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value
  }]
}
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "task_security_group_id" { value = aws_security_group.task.id }
output "cluster_name" { value = aws_ecs_cluster.main.name }
output "migrate_task_definition" { value = aws_ecs_task_definition.migrate.family }
