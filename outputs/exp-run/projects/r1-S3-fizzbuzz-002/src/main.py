def fizzbuzz(n: int) -> str:
    d3 = n % 3 == 0
    d5 = n % 5 == 0
    result = 'Fizz' * d3 + 'Buzz' * d5
    return result or str(n)
