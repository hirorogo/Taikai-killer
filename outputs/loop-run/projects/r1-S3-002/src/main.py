def fizzbuzz(n: int) -> str:
    div3 = (n % 3 == 0)
    div5 = (n % 5 == 0)
    result = ("Fizz" if div3 else "") + ("Buzz" if div5 else "")
    return result if result else str(n)
