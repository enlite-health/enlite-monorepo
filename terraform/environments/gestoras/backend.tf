# State PRÓPRIO (prefix distinto): o stack das gestoras aplica independente do prd.
terraform {
  backend "gcs" {
    bucket = "enlite-tf-state"
    prefix = "gestoras"
  }
}
