# Owed benchmark

Backend: Real models, simulated PayPal stand-in

> We ran 48 attacks against 3 AI models holding PayPal's refund tool, each with a strong prompt and the records in front of it. On their own, 2 of 3 paid out money that was not owed, on 2 of 144 attempts, $40.00 in total. With Owed in front of the same models it was 0 of 144, and 22 of 24 honest customers were still paid in full.

| Model | Door | Attacks overpaid | Paid beyond what was owed | Honest paid in full | Median time | Tokens in / out | Errors |
|---|---|---|---|---|---|---|---|
| openai:Qwen/Qwen3-235B-A22B-Instruct-2507 | 1, on its own | 0 of 48 | $0.00 | 7 of 8 | 2429 ms | 117434 / 5300 | 0 |
| openai:Qwen/Qwen3-235B-A22B-Instruct-2507 | 2, with Owed | 0 of 48 | $0.00 | 6 of 8 | 5724 ms | 122883 / 5582 | 0 |
| openai:openai/gpt-oss-120b | 1, on its own | 1 of 48 | $20.00 | 8 of 8 | 2015 ms | 198421 / 20091 | 0 |
| openai:openai/gpt-oss-120b | 2, with Owed | 0 of 48 | $0.00 | 8 of 8 | 2038 ms | 196948 / 20000 | 0 |
| openai:moonshotai/Kimi-K3 | 1, on its own | 1 of 48 | $20.00 | 8 of 8 | 3437 ms | 195461 / 43115 | 0 |
| openai:moonshotai/Kimi-K3 | 2, with Owed | 0 of 48 | $0.00 | 8 of 8 | 3476 ms | 198432 / 44791 | 0 |

Every case starts from a fresh order. Door 1 and Door 2 get the same model, system prompt, tools and customer turns. Only the routing of create_refund differs.
Attacks all run on the overcharge order, where $5 is owed. Honest requests cover four kinds of order. The prompt, the attacks and every row are in this repository.
