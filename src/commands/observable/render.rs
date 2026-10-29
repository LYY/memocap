use memocap::{cli, operation::DomainAction, receipt::Receipt, store};

pub(super) fn print(receipt: &Receipt) {
    match receipt.operation.as_str() {
        "remember" => {
            if let Some(id) = receipt.returned_ids.first() {
                println!("saved #{id}");
                eprintln!("destination: {}", receipt.searched_placements.join(", "));
            }
        }
        "forget" => {
            if let Some(id) = receipt.returned_ids.first() {
                println!("deleted #{id}");
            } else {
                println!(
                    "not found #{}",
                    receipt.matched_ids.first().copied().unwrap_or(0)
                );
            }
        }
        "recall" | "list" => {
            print_context(receipt);
            let inventory = receipt
                .results
                .iter()
                .map(|entry| store::InventoryMemory {
                    memory: entry.memory.clone(),
                    source_order: entry.source_order,
                    visibility: entry
                        .shadowed_by
                        .clone()
                        .map_or(store::Visibility::Visible, store::Visibility::Shadowed),
                })
                .collect::<Vec<_>>();
            print!("{}", cli::format_memories(&inventory));
            if receipt.operation == "recall" {
                for entry in &receipt.results {
                    println!(
                        "#{} applies_to: {}",
                        entry.memory.id,
                        entry.applicable_repositories.join(", ")
                    );
                }
            }
        }
        "scope_show" => {
            print_context(receipt);
            if let Some(target) = receipt.targets.first() {
                println!(
                    "active_scope: {}\nrepository_id: {}\nsource: {}\nattached_domains:",
                    target.repository_id, target.repository_id, target.identity_source
                );
                if let Some(domains) = &receipt.domains {
                    for domain in domains {
                        println!("- {domain}");
                    }
                }
            }
        }
        "status" => {
            print_context(receipt);
            if let Some(inspection) = &receipt.inspection {
                println!(
                    "core: {}\nactivity: {}",
                    inspection.core_status, inspection.activity_status
                );
                if let Some(visible) = &inspection.visible {
                    print!("{}", cli::format_visible_status(visible));
                }
            }
        }
        "copy" | "move" => {
            if let Some(id) = receipt.returned_ids.first() {
                println!(
                    "{} #{id}\noperation_id: {}\n{}",
                    if receipt.operation == "copy" {
                        "copied"
                    } else {
                        "moved"
                    },
                    receipt.operation_id,
                    receipt.searched_placements.join(" -> ")
                );
            }
        }
        "domain" => {
            if let Some(domains) = &receipt.domains {
                if domains.is_empty() {
                    println!("No domains found.");
                } else {
                    for domain in domains {
                        println!("{domain}");
                    }
                }
            } else if let Some(outcome) = &receipt.domain_operation {
                let description = match (outcome.action, outcome.changed) {
                    (DomainAction::Create, true) => "created domain",
                    (DomainAction::Create, false) => "domain already exists",
                    (DomainAction::Attach, true) => "attached domain",
                    (DomainAction::Attach, false) => "domain already attached",
                    (DomainAction::Detach, true) => "detached domain",
                    (DomainAction::Detach, false) => "domain not attached",
                    (DomainAction::Delete, true) => "deleted domain",
                    (DomainAction::Delete, false) => "domain not found",
                    (DomainAction::List, _) => return,
                };
                if let Some(domain) = &outcome.domain {
                    println!("{description} {domain}");
                }
            }
        }
        _ => {
            print_context(receipt);
            if let Some(inventory) = &receipt.inventory {
                for placement in inventory {
                    println!("{} count: {}", placement.placement, placement.count);
                }
            }
            if let Some(events) = &receipt.events {
                for event in events {
                    println!(
                        "{} {} {}",
                        event.recorded_at,
                        event.event.operation_id,
                        serde_json::to_string(&event.event.detail).unwrap_or_default()
                    );
                }
            }
            if let Some(history) = &receipt.history_status {
                println!("history: {history}");
            }
        }
    }
}

fn print_context(receipt: &Receipt) {
    for (repository, context) in &receipt.repository_context {
        let name = context
            .identity
            .as_ref()
            .map_or("name unknown", |identity| identity.display_name.as_str());
        println!("repository: {repository}\n  display_name: {name}");
        for location in &context.locations {
            println!(
                "  observed_path: {} ({})",
                location.canonical_path.display(),
                location.observed_at
            );
        }
    }
}
