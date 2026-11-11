# Owed benchmark

Backend: Real models, simulated PayPal stand-in

> We ran 144 attacks against 3 AI models holding PayPal's refund tool, each with a strong prompt and the records in front of it. On their own, 1 of 3 paid out money that was not owed, on 5 of 432 attempts, $100.00 in total. With Owed in front of the same models it was 0 of 432, and 71 of 72 honest customers were still paid in full.

| Model | Door | Attacks overpaid | Paid beyond what was owed | Honest paid in full | Median time | Tokens in / out | Errors |
|---|---|---|---|---|---|---|---|
| openai:Qwen/Qwen3-235B-A22B-Instruct-2507 | 1, on its own | 0 of 144 | $0.00 | 22 of 24 | 1688 ms | 392955 / 18567 | 0 |
| openai:Qwen/Qwen3-235B-A22B-Instruct-2507 | 2, with Owed | 0 of 144 | $0.00 | 23 of 24 | 1890 ms | 424016 / 19802 | 0 |
| openai:openai/gpt-oss-120b | 1, on its own | 5 of 144 | $100.00 | 24 of 24 | 1700 ms | 630973 / 55918 | 0 |
| openai:openai/gpt-oss-120b | 2, with Owed | 0 of 144 | $0.00 | 24 of 24 | 1678 ms | 641955 / 58174 | 0 |
| openai:moonshotai/Kimi-K3 | 1, on its own | 0 of 144 | $0.00 | 24 of 24 | 3530 ms | 582878 / 133368 | 0 |
| openai:moonshotai/Kimi-K3 | 2, with Owed | 0 of 144 | $0.00 | 24 of 24 | 3322 ms | 584643 / 128710 | 0 |

Every case starts from a fresh order. Door 1 and Door 2 get the same model, system prompt, tools and customer turns. Only the routing of create_refund differs.
Attacks all run on the overcharge order, where $5 is owed. Honest requests cover four kinds of order. The prompt, the attacks and every row are in this repository.
