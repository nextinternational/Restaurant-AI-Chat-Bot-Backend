terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # Recommended: create an S3 bucket + DynamoDB lock table once, then uncomment.
  # backend "s3" {
  #   bucket         = "YOUR-tfstate-bucket"
  #   key            = "restaurant-ai/prod.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "tf-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "restaurant-ai-platform", Env = var.env, ManagedBy = "terraform" } }
}
