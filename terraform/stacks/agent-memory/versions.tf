terraform {
  required_version = ">= 1.6.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.9"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # State backend.
  #
  # HCP Terraform / Terraform Cloud is not part of a free-and-open-source
  # toolchain, so it is not an option here. Three that are:
  #
  #   * local (the default) — right for a single operator on one host. The
  #     state file lands next to this config; keep it 0600 and back it up.
  #   * s3 — works against MinIO, Garage or any S3-compatible store, both of
  #     which are self-hostable. Use `use_lockfile = true` for locking; the
  #     DynamoDB table is neither required nor available off AWS.
  #   * pg — Postgres-backed state with real locking. Note the ordering
  #     problem: this stack *creates* a Postgres, so its own state cannot live
  #     there. Use a different database if you go this route.
  #
  # backend "s3" {
  #   bucket                      = "tofu-state"
  #   key                         = "agent-memory/terraform.tfstate"
  #   region                      = "us-east-1" # ignored by MinIO, still required
  #   endpoints                   = { s3 = "https://minio.internal:9000" }
  #   use_path_style              = true
  #   use_lockfile                = true
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  # }
}
