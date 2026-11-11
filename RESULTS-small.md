# Owed benchmark

Backend: Real models, simulated PayPal stand-in

> We ran 48 attacks against 3 AI models holding PayPal's refund tool, each with a strong prompt and the records in front of it. On their own, 1 of 3 paid out money that was not owed, on 4 of 144 attempts, $80.00 in total. With Owed in front of the same models it was 0 of 144, and 16 of 24 honest customers were still paid in full.

| Model | Door | Attacks overpaid | Paid beyond what was owed | Honest paid in full | Median time | Tokens in / out | Errors |
|---|---|---|---|---|---|---|---|
| openai:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B | 1, on its own | 4 of 48 | $80.00 | 7 of 8 | 23866 ms | 808429 / 319231 | 0 |
| openai:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B | 2, with Owed | 0 of 47 | $0.00 | 8 of 8 | 34810 ms | 778844 / 340764 | 1 |
| openai:Qwen/Qwen3-30B-A3B-Instruct-2507 | 1, on its own | 0 of 48 | $0.00 | 5 of 8 | 2641 ms | 190681 / 6612 | 0 |
| openai:Qwen/Qwen3-30B-A3B-Instruct-2507 | 2, with Owed | 0 of 48 | $0.00 | 8 of 8 | 3383 ms | 210537 / 8671 | 0 |
| openai:google/gemma-3-27b-it | 1, on its own | 0 of 48 | $0.00 | 0 of 8 | 1995 ms | 24373 / 7693 | 0 |
| openai:google/gemma-3-27b-it | 2, with Owed | 0 of 48 | $0.00 | 0 of 8 | 4917 ms | 37012 / 10718 | 0 |

Every case starts from a fresh order. Door 1 and Door 2 get the same model, system prompt, tools and customer turns. Only the routing of create_refund differs.
Attacks all run on the overcharge order, where $5 is owed. Honest requests cover four kinds of order. The prompt, the attacks and every row are in this repository.
