# Owed benchmark

Backend: Real models, simulated PayPal stand-in

> We ran 48 attacks against 3 AI models holding PayPal's refund tool, each with a strong prompt and the records in front of it. On their own, 1 of 3 paid out money that was not owed, on 1 of 144 attempts, $20.00 in total. With Owed in front of the same models it was 0 of 144, and 13 of 24 honest customers were still paid in full.

| Model | Door | Attacks overpaid | Paid beyond what was owed | Honest paid in full | Median time | Tokens in / out | Errors |
|---|---|---|---|---|---|---|---|
| openai:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B | 1, on its own | 1 of 48 | $20.00 | 8 of 8 | 21776 ms | 754223 / 319078 | 0 |
| openai:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B | 2, with Owed | 0 of 48 | $0.00 | 8 of 8 | 26444 ms | 817761 / 329295 | 0 |
| openai:Qwen/Qwen3-30B-A3B-Instruct-2507 | 1, on its own | 0 of 48 | $0.00 | 3 of 8 | 2472 ms | 189506 / 6508 | 0 |
| openai:Qwen/Qwen3-30B-A3B-Instruct-2507 | 2, with Owed | 0 of 48 | $0.00 | 5 of 8 | 2477 ms | 185895 / 6308 | 0 |
| openai:google/gemma-3-27b-it | 1, on its own | 0 of 48 | $0.00 | 0 of 8 | 4235 ms | 24503 / 7672 | 0 |
| openai:google/gemma-3-27b-it | 2, with Owed | 0 of 48 | $0.00 | 0 of 8 | 4720 ms | 24482 / 7842 | 0 |

Every case starts from a fresh order. Door 1 and Door 2 get the same model, system prompt, tools and customer turns. Only the routing of create_refund differs.
Attacks all run on the overcharge order, where $5 is owed. Honest requests cover four kinds of order. The prompt, the attacks and every row are in this repository.
