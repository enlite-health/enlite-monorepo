# OWN state (distinct prefix): the assistants stack applies independently of prd.
terraform {
  backend "gcs" {
    bucket = "enlite-tf-state"
    prefix = "assistants"
  }
}
